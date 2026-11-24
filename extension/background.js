import { attachedTabs, detachAll, detachIdle, detach } from './lib/cdp.js';
import { browserHandlers } from './lib/browser.js';
import { attachForAllTabsRules, networkHandlers, networkSummary, resetNetwork } from './lib/network.js';
import { pageHandlers } from './lib/page.js';
import { activity, isForbiddenUrl, loadSettings, record, saveSettings, session, settings } from './lib/state.js';

const VERSION = chrome.runtime.getManifest().version;
const RECONNECT_ALARM = 'reconnect';
const IDLE_ALARM = 'idle-detach';
const KEEPALIVE_MS = 20_000;
const RETRY_MS = 1500;
const IDLE_DETACH_MS = 5 * 60_000;

const handlers = { ...pageHandlers, ...networkHandlers, ...browserHandlers };

let socket = null;
let keepalive = null;
let retryTimer = null;
let connecting = null;
const ready = loadSettings();

function isOpen() {
  return socket?.readyState === WebSocket.OPEN;
}

function updateBadge() {
  const paused = !settings.enabled;
  const text = paused ? 'OFF' : isOpen() ? 'ON' : '...';
  const color = paused ? '#b42318' : isOpen() ? '#1a7f4b' : '#6b7280';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function describeArgs(args) {
  return args.url ?? args.selector ?? args.ref ?? args.method ?? args.action ?? args.id ?? '';
}

async function dispatch(method, params) {
  await ready;
  if (!settings.enabled) throw new Error('El conector está pausado por el usuario desde el popup.');
  if (method === 'status') return statusPayload();
  const handler = handlers[method];
  if (!handler) throw new Error(`Herramienta desconocida: ${method}`);
  return handler(params ?? {});
}

function statusPayload() {
  return {
    version: VERSION,
    enabled: settings.enabled,
    redactSecrets: settings.redactSecrets,
    blockedDomains: settings.blockedDomains,
    currentTabId: session.currentTabId,
    attachedTabs: attachedTabs(),
    ...networkSummary(),
  };
}

async function onMessage(event) {
  const message = JSON.parse(event.data);
  if (message.type !== 'req') return;
  const { id, method, params } = message;
  try {
    const result = await dispatch(method, params);
    record(method, describeArgs(params ?? {}), true);
    socket?.send(JSON.stringify({ type: 'res', id, result: result ?? {} }));
  } catch (error) {
    record(method, error.message, false);
    socket?.send(JSON.stringify({ type: 'res', id, error: error.message }));
  }
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, RETRY_MS);
}

async function readPairing() {
  const response = await fetch(chrome.runtime.getURL('pairing.json'));
  return response.json();
}

async function openSocket() {
  await ready;
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  let pairing;
  try {
    pairing = await readPairing();
  } catch {
    updateBadge();
    return;
  }
  const ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/ext`);
  socket = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', token: pairing.token, version: VERSION }));
    clearInterval(keepalive);
    keepalive = setInterval(() => isOpen() && ws.send('{"type":"ping"}'), KEEPALIVE_MS);
    updateBadge();
  };
  ws.onmessage = onMessage;
  ws.onclose = () => {
    if (socket !== ws) return;
    clearInterval(keepalive);
    socket = null;
    updateBadge();
    scheduleRetry();
  };
  ws.onerror = () => {};
}

function connect() {
  connecting ??= openSocket().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function stopEverything() {
  resetNetwork();
  await chrome.declarativeNetRequest.getSessionRules().then((rules) =>
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((rule) => rule.id) }),
  );
  await detachAll();
}

async function applySettings(patch) {
  await saveSettings(patch);
  if (patch.enabled === false) await stopEverything();
  updateBadge();
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  (async () => {
    await ready;
    if (message.type === 'getState') {
      reply({ ...statusPayload(), connected: isOpen(), activity: activity.slice(0, 40) });
    } else if (message.type === 'setSettings') {
      await applySettings(message.patch);
      reply({ ok: true });
    } else if (message.type === 'stopAll') {
      await stopEverything();
      reply({ ok: true });
    }
  })();
  return true;
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id != null) attachForAllTabsRules(tab.id).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && attachedTabs().includes(tabId) && isForbiddenUrl(change.url)) detach(tabId);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
  if (alarm.name === IDLE_ALARM) detachIdle(IDLE_DETACH_MS);
});

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.create(IDLE_ALARM, { periodInMinutes: 1 });
ready.then(() => {
  updateBadge();
  connect();
});
