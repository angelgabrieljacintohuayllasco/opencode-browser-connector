const COMMAND_TIMEOUT_MS = 30_000;
const CONSOLE_LIMIT = 1000;
const EVENT_LIMIT = 2000;

const tabs = new Map();
const eventListeners = new Set();
const attachListeners = new Set();
const detachListeners = new Set();
const subscriptions = { methods: new Set(), buffer: [] };

export const onCdpEvent = (fn) => eventListeners.add(fn);
export const onSessionAttached = (fn) => attachListeners.add(fn);
export const onTabDetached = (fn) => detachListeners.add(fn);

export function attachedTabs() {
  return [...tabs.keys()];
}

export function tabState(tabId) {
  return tabs.get(tabId);
}

export function holdTab(tabId, reason) {
  tabs.get(tabId)?.holds.add(reason);
}

export function releaseTab(tabId, reason) {
  tabs.get(tabId)?.holds.delete(reason);
}

export function childSessions(tabId) {
  return [...(tabs.get(tabId)?.sessions.values() ?? [])];
}

export async function ensureAttached(tabId) {
  const existing = tabs.get(tabId);
  if (existing) {
    existing.lastUse = Date.now();
    await existing.ready;
    return existing;
  }
  const state = {
    tabId,
    lastUse: Date.now(),
    sessions: new Map(),
    holds: new Set(),
    console: [],
    inflight: new Set(),
    lastNetworkAt: Date.now(),
    dialog: null,
    dialogPolicy: 'manual',
  };
  tabs.set(tabId, state);
  state.ready = attach(state);
  try {
    await state.ready;
  } catch (error) {
    tabs.delete(tabId);
    throw error;
  }
  return state;
}

async function attach(state) {
  const { tabId } = state;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (error) {
    throw new Error(`No se pudo adjuntar a la pestaña ${tabId}: ${error.message}`);
  }
  await enableDomains(tabId, undefined, 'page');
  for (const listener of attachListeners) await listener(tabId, undefined);
  await send(tabId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
}

async function enableDomains(tabId, sessionId, targetType) {
  const domains = targetType === 'worker' ? ['Runtime', 'Network'] : ['Page', 'Runtime', 'Log', 'Network'];
  for (const domain of domains) {
    const params = domain === 'Network' ? { maxTotalBufferSize: 100_000_000, maxResourceBufferSize: 10_000_000 } : {};
    await send(tabId, `${domain}.enable`, params, sessionId);
  }
  // Background tabs otherwise stall input and screenshots for seconds.
  if (targetType === 'page') await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
}

export async function send(tabId, method, params = {}, sessionId, timeoutMs = COMMAND_TIMEOUT_MS) {
  const target = sessionId ? { tabId, sessionId } : { tabId };
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const dialog = tabs.get(tabId)?.dialog;
      const hint = dialog ? ` Hay un diálogo abierto ("${dialog.message}"): usa la herramienta dialog.` : '';
      reject(new Error(`Timeout en ${method} tras ${timeoutMs} ms.${hint}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([chrome.debugger.sendCommand(target, method, params), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function detach(tabId) {
  if (!tabs.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    cleanup(tabId, 'already_detached');
  }
}

export async function detachAll() {
  await Promise.all(attachedTabs().map(detach));
}

export async function detachIdle(maxIdleMs) {
  const now = Date.now();
  for (const [tabId, state] of tabs) {
    if (!state.holds.size && now - state.lastUse > maxIdleMs) await detach(tabId);
  }
}

function cleanup(tabId, reason) {
  if (!tabs.delete(tabId)) return;
  for (const listener of detachListeners) listener(tabId, reason);
}

export function subscribe(methods) {
  for (const method of methods) subscriptions.methods.add(method);
}

export function unsubscribeAll() {
  subscriptions.methods.clear();
  subscriptions.buffer.length = 0;
}

export function drainEvents(limit) {
  return subscriptions.buffer.splice(0, limit);
}

function pushConsole(state, entry) {
  state.console.push({ at: Date.now(), ...entry });
  if (state.console.length > CONSOLE_LIMIT) state.console.shift();
}

function describeRemoteArg(arg) {
  if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  return arg.description ?? arg.type;
}

function trackBuiltins(state, method, params) {
  switch (method) {
    case 'Runtime.consoleAPICalled':
      pushConsole(state, { level: params.type, text: params.args.map(describeRemoteArg).join(' ') });
      break;
    case 'Runtime.exceptionThrown': {
      const details = params.exceptionDetails;
      pushConsole(state, { level: 'exception', text: details.exception?.description ?? details.text });
      break;
    }
    case 'Log.entryAdded':
      pushConsole(state, { level: params.entry.level, text: params.entry.text, url: params.entry.url });
      break;
    case 'Network.requestWillBeSent':
      state.inflight.add(params.requestId);
      state.lastNetworkAt = Date.now();
      break;
    case 'Network.loadingFinished':
    case 'Network.loadingFailed':
      state.inflight.delete(params.requestId);
      state.lastNetworkAt = Date.now();
      break;
    case 'Page.javascriptDialogOpening':
      state.dialog = { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt };
      if (state.dialogPolicy !== 'manual') {
        send(state.tabId, 'Page.handleJavaScriptDialog', { accept: state.dialogPolicy === 'accept' }).catch(() => {});
      }
      break;
    case 'Page.javascriptDialogClosed':
      state.dialog = null;
      break;
    default:
  }
}

async function handleChildAttached(tabId, parentSessionId, params) {
  const { sessionId, targetInfo, waitingForDebugger } = params;
  const state = tabs.get(tabId);
  if (!state) return;
  const type = targetInfo.type === 'iframe' ? 'iframe' : 'worker';
  state.sessions.set(sessionId, { sessionId, type, targetId: targetInfo.targetId, url: targetInfo.url });
  try {
    await enableDomains(tabId, sessionId, type);
    for (const listener of attachListeners) await listener(tabId, sessionId);
    if (type === 'iframe') {
      await send(tabId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    }
  } catch {
    state.sessions.delete(sessionId);
  } finally {
    if (waitingForDebugger) send(tabId, 'Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const { tabId, sessionId } = source;
  const state = tabs.get(tabId);
  if (!state) return;
  if (method === 'Target.attachedToTarget') {
    handleChildAttached(tabId, sessionId, params);
    return;
  }
  if (method === 'Target.detachedFromTarget') {
    state.sessions.delete(params.sessionId);
    return;
  }
  trackBuiltins(state, method, params);
  for (const listener of eventListeners) listener(tabId, sessionId, method, params);
  if (subscriptions.methods.has(method) || subscriptions.methods.has('*')) {
    subscriptions.buffer.push({ at: Date.now(), tabId, sessionId, method, params });
    if (subscriptions.buffer.length > EVENT_LIMIT) subscriptions.buffer.shift();
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId != null) cleanup(source.tabId, reason);
});

chrome.tabs.onRemoved.addListener((tabId) => cleanup(tabId, 'tab_closed'));
