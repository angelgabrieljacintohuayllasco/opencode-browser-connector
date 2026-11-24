import { parseKeyCombo } from './policy.js';
import { childSessions, ensureAttached, holdTab, releaseTab, send, tabState } from './cdp.js';
import { resolveTab } from './state.js';

const DEFAULT_SNAPSHOT_CHARS = 30_000;
const POLL_MS = 150;
const SCREENSHOT_HIDDEN_TIMEOUT_MS = 5000;
const SCREENSHOT_VISIBLE_TIMEOUT_MS = 20_000;
const SCREENCAST_IDLE_MS = 5000;
const NETWORK_IDLE_MS = 500;
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio',
  'switch', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
]);
const SKIPPED_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak', 'presentation']);
const REPORTED_PROPERTIES = ['checked', 'expanded', 'selected', 'disabled', 'required', 'focused', 'pressed', 'level'];
const TOP_LEVEL_AWAIT = /^SyntaxError: await is only valid/;
const REDECLARED = /^SyntaxError: Identifier .* has already been declared/;

async function evaluate(tabId, expression, { sessionId, awaitPromise = true, timeoutMs } = {}) {
  const { result, exceptionDetails } = await send(
    tabId,
    'Runtime.evaluate',
    { expression, awaitPromise, returnByValue: true, userGesture: true },
    sessionId,
    timeoutMs,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

function nodeLine(node, depth, ref) {
  const role = node.role?.value;
  const name = node.name?.value?.trim();
  const value = node.value?.value;
  const flags = [];
  for (const property of node.properties ?? []) {
    if (REPORTED_PROPERTIES.includes(property.name) && property.value?.value) {
      flags.push(property.value.value === true ? property.name : `${property.name}=${property.value.value}`);
    }
  }
  const parts = [`${'  '.repeat(depth)}- ${role}`];
  if (name) parts.push(JSON.stringify(name.slice(0, 200)));
  if (value !== undefined && value !== '') parts.push(`value=${JSON.stringify(String(value).slice(0, 120))}`);
  if (ref) parts.push(`[ref=${ref}]`);
  if (flags.length) parts.push(`(${flags.join(', ')})`);
  return parts.join(' ');
}

function renderTree(nodes, prefix, options) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root = nodes.find((node) => !node.parentId) ?? nodes[0];
  const lines = [];
  const walk = (node, depth) => {
    if (!node) return;
    const role = node.role?.value;
    const name = node.name?.value?.trim();
    const hidden = node.ignored || SKIPPED_ROLES.has(role) || (role === 'StaticText' && !name);
    const interactive = INTERACTIVE_ROLES.has(role);
    const shown = !hidden && (!options.interactiveOnly || interactive);
    if (shown) {
      const ref = node.backendDOMNodeId && role !== 'StaticText' ? `${prefix}e${node.backendDOMNodeId}` : undefined;
      lines.push(nodeLine(node, depth, ref));
    }
    for (const childId of node.childIds ?? []) walk(byId.get(childId), depth + (shown ? 1 : 0));
  };
  walk(root, 0);
  return lines;
}

function flattenFrames(tree) {
  return [tree.frame, ...(tree.childFrames ?? []).flatMap(flattenFrames)];
}

async function frameLines(tabId, sessionId, prefix, options) {
  await send(tabId, 'Accessibility.enable', {}, sessionId);
  const { frameTree } = await send(tabId, 'Page.getFrameTree', {}, sessionId);
  const output = [];
  for (const frame of flattenFrames(frameTree)) {
    const { nodes } = await send(tabId, 'Accessibility.getFullAXTree', { frameId: frame.id }, sessionId).catch(() => ({ nodes: [] }));
    const lines = renderTree(nodes, prefix, options);
    if (frame.parentId && lines.length) output.push(`# frame ${frame.url}`);
    output.push(...lines);
  }
  return output;
}

function sessionForRef(tabId, sessionIndex) {
  if (sessionIndex == null) return undefined;
  const child = childSessions(tabId).filter((item) => item.type === 'iframe')[sessionIndex];
  if (!child) throw new Error('El frame de esa ref ya no existe. Pide un snapshot nuevo.');
  return child.sessionId;
}

function parseRef(tabId, ref) {
  const match = /^(?:s(\d+))?e(\d+)$/.exec(ref);
  if (!match) throw new Error(`Ref inválida: ${ref}`);
  return { sessionId: sessionForRef(tabId, match[1] != null ? Number(match[1]) : undefined), backendNodeId: Number(match[2]) };
}

const FIND_BY_TEXT = `(needle) => {
  const wanted = needle.trim().toLowerCase();
  const seen = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) visit(element.shadowRoot);
      const text = (element.innerText || element.value || element.getAttribute('aria-label') || '').trim().toLowerCase();
      if (text.includes(wanted)) seen.push(element);
    }
  };
  visit(document);
  const exact = seen.filter((element) => (element.innerText || element.value || '').trim().toLowerCase() === wanted);
  const pool = exact.length ? exact : seen;
  return pool.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0] ?? null;
}`;

async function resolveSelector(tabId, selector) {
  const isText = selector.startsWith('text=');
  const expression = isText
    ? `(${FIND_BY_TEXT})(${JSON.stringify(selector.slice(5))})`
    : `document.querySelector(${JSON.stringify(selector)})`;
  const { result, exceptionDetails } = await send(tabId, 'Runtime.evaluate', { expression });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  if (result.subtype === 'null' || !result.objectId) throw new Error(`No se encontró: ${selector}`);
  const { node } = await send(tabId, 'DOM.describeNode', { objectId: result.objectId });
  return { backendNodeId: node.backendNodeId };
}

async function resolveElement(tabId, args) {
  if (args.ref) return parseRef(tabId, args.ref);
  if (args.selector) return resolveSelector(tabId, args.selector);
  throw new Error('Indica ref o selector');
}

function quadCenter(quad) {
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  };
}

async function contentCenter(tabId, sessionId, backendNodeId) {
  const { quads } = await send(tabId, 'DOM.getContentQuads', { backendNodeId }, sessionId);
  const usable = quads?.find((quad) => {
    const center = quadCenter(quad);
    return Number.isFinite(center.x) && Math.abs(quad[0] - quad[4]) + Math.abs(quad[1] - quad[5]) > 0;
  });
  if (!usable) throw new Error('El elemento no es visible');
  return quadCenter(usable);
}

async function frameOffset(tabId, sessionId) {
  if (!sessionId) return { x: 0, y: 0 };
  const child = childSessions(tabId).find((item) => item.sessionId === sessionId);
  const { backendNodeId } = await send(tabId, 'DOM.getFrameOwner', { frameId: child.targetId });
  return contentCenterTopLeft(tabId, backendNodeId);
}

async function contentCenterTopLeft(tabId, backendNodeId) {
  const { quads } = await send(tabId, 'DOM.getContentQuads', { backendNodeId });
  return { x: quads[0][0], y: quads[0][1] };
}

async function elementPoint(tabId, element) {
  const { sessionId, backendNodeId } = element;
  await send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }, sessionId).catch(() => {});
  const center = await contentCenter(tabId, sessionId, backendNodeId);
  const offset = await frameOffset(tabId, sessionId);
  return { x: center.x + offset.x, y: center.y + offset.y };
}

async function targetPoint(tabId, args) {
  if (args.x != null && args.y != null) return { x: args.x, y: args.y };
  return elementPoint(tabId, await resolveElement(tabId, args));
}

function mouse(tabId, type, point, extra = {}) {
  return send(tabId, 'Input.dispatchMouseEvent', { type, x: point.x, y: point.y, ...extra });
}

async function clickAt(tabId, point, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
  await mouse(tabId, 'mouseMoved', point);
  await mouse(tabId, 'mousePressed', point, { button, clickCount, modifiers, buttons: 1 });
  await mouse(tabId, 'mouseReleased', point, { button, clickCount, modifiers });
}

async function callOnNode(tabId, element, fn, ...args) {
  const { object } = await send(tabId, 'DOM.resolveNode', { backendNodeId: element.backendNodeId }, element.sessionId);
  const { result, exceptionDetails } = await send(
    tabId,
    'Runtime.callFunctionOn',
    { objectId: object.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true },
    element.sessionId,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function pressKey(tabId, combo) {
  const { key, code, vk, text, modifiers, commands } = parseKeyCombo(combo);
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await send(tabId, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text, unmodifiedText: text, commands });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

function waitTick() {
  return new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

function networkIdle(tabId) {
  const state = tabState(tabId);
  return state.inflight.size === 0 && Date.now() - state.lastNetworkAt >= NETWORK_IDLE_MS;
}

async function condition(tabId, args) {
  if (args.networkIdle) return networkIdle(tabId);
  const checks = [];
  if (args.text != null) checks.push(`document.body?.innerText.includes(${JSON.stringify(args.text)})`);
  if (args.textGone != null) checks.push(`!document.body?.innerText.includes(${JSON.stringify(args.textGone)})`);
  if (args.selector) checks.push(`!!document.querySelector(${JSON.stringify(args.selector)})`);
  if (args.selectorGone) checks.push(`!document.querySelector(${JSON.stringify(args.selectorGone)})`);
  if (args.urlContains) checks.push(`location.href.includes(${JSON.stringify(args.urlContains)})`);
  if (args.expression) checks.push(`!!(${args.expression})`);
  if (!checks.length) throw new Error('Indica una condición: text, selector, urlContains, expression o networkIdle');
  return evaluate(tabId, checks.join(' && '), { awaitPromise: false });
}

async function screenshotClip(tabId, args) {
  if (args.ref || args.selector) {
    const element = await resolveElement(tabId, args);
    const { model } = await send(tabId, 'DOM.getBoxModel', { backendNodeId: element.backendNodeId }, element.sessionId);
    const offset = await frameOffset(tabId, element.sessionId);
    return { x: model.border[0] + offset.x, y: model.border[1] + offset.y, width: model.width, height: model.height, scale: 1 };
  }
  if (args.fullPage) {
    const { cssContentSize } = await send(tabId, 'Page.getLayoutMetrics');
    return { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
  }
  return undefined;
}

// Chrome skips compositing for hidden tabs, which makes captures take from 100 ms
// to 30 s. An active screencast keeps the tab rendering without bringing it forward.
async function keepRendering(tabId) {
  const state = tabState(tabId);
  if (!state.screencastTimer) {
    await send(tabId, 'Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 16, maxHeight: 16, everyNthFrame: 60 });
  }
  clearTimeout(state.screencastTimer);
  state.screencastTimer = setTimeout(() => {
    state.screencastTimer = null;
    send(tabId, 'Page.stopScreencast').catch(() => {});
  }, SCREENCAST_IDLE_MS);
}

// Last resort for minimized or fully covered windows: briefly shows the tab, then
// returns the window to the tab the user had open.
async function withVisibleTab(tabId, action) {
  const { windowId } = await chrome.tabs.get(tabId);
  const [previous] = await chrome.tabs.query({ active: true, windowId });
  const { state } = await chrome.windows.get(windowId);
  await chrome.windows.update(windowId, { focused: true, ...(state === 'minimized' && { state: 'normal' }) });
  await chrome.tabs.update(tabId, { active: true });
  try {
    return await action();
  } finally {
    if (previous && previous.id !== tabId) await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
    if (state === 'minimized') await chrome.windows.update(windowId, { state }).catch(() => {});
  }
}

async function pageInfo(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return { tabId, url: tab.url, title: tab.title };
}

const STORAGE_SCRIPT = `(kind, action, key, value) => {
  const store = kind === 'session' ? sessionStorage : localStorage;
  if (action === 'set') { store.setItem(key, value); return true; }
  if (action === 'remove') { store.removeItem(key); return true; }
  if (action === 'clear') { store.clear(); return true; }
  if (action === 'keys') return Object.keys(store);
  return key != null ? store.getItem(key) : Object.fromEntries(Object.entries(store));
}`;

export const pageHandlers = {
  async snapshot(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    const options = { interactiveOnly: Boolean(args.interactiveOnly) };
    const lines = await frameLines(tabId, undefined, '', options);
    const frames = childSessions(tabId).filter((item) => item.type === 'iframe');
    for (const [index, child] of frames.entries()) {
      const childLines = await frameLines(tabId, child.sessionId, `s${index}`, options).catch(() => []);
      if (childLines.length) lines.push(`# frame ${child.url}`, ...childLines);
    }
    const text = lines.join('\n');
    const limit = args.maxChars ?? DEFAULT_SNAPSHOT_CHARS;
    return { ...(await pageInfo(tabId)), truncated: text.length > limit || undefined, snapshot: text.slice(0, limit) };
  },

  async read_page(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    const target = args.selector ? `document.querySelector(${JSON.stringify(args.selector)})` : 'document.body';
    const property = args.format === 'html' ? 'outerHTML' : 'innerText';
    const content = await evaluate(tabId, `${target}?.${property} ?? ''`);
    const limit = args.maxChars ?? 50_000;
    return { ...(await pageInfo(tabId)), length: content.length, content: content.slice(0, limit) };
  },

  async screenshot(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    await keepRendering(tabId);
    const clip = await screenshotClip(tabId, args);
    const format = args.format ?? 'jpeg';
    const params = {
      format,
      quality: format === 'jpeg' ? args.quality ?? 75 : undefined,
      clip,
      captureBeyondViewport: Boolean(clip),
    };
    const capture = (timeoutMs) => send(tabId, 'Page.captureScreenshot', params, undefined, timeoutMs);
    const { data } = await capture(SCREENSHOT_HIDDEN_TIMEOUT_MS).catch(() => withVisibleTab(tabId, () => capture(SCREENSHOT_VISIBLE_TIMEOUT_MS)));
    return { __image: data, mimeType: `image/${format}`, ...(await pageInfo(tabId)) };
  },

  async pdf(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    const { data } = await send(tabId, 'Page.printToPDF', { printBackground: true, landscape: Boolean(args.landscape) }, undefined, 60_000);
    return { __saveBase64: data };
  },

  async click(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    const point = await targetPoint(tabId, args);
    await clickAt(tabId, point, args);
    return { clicked: point, ...(await pageInfo(tabId)) };
  },

  async type(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    if (args.ref || args.selector) {
      const element = await resolveElement(tabId, args);
      await send(tabId, 'DOM.focus', { backendNodeId: element.backendNodeId }, element.sessionId).catch(async () => {
        await clickAt(tabId, await elementPoint(tabId, element));
      });
      if (args.clear !== false) {
        await callOnNode(tabId, element, `function () {
          if (this.isContentEditable) document.execCommand('selectAll');
          else if (this.select) this.select();
        }`);
      }
    }
    await send(tabId, 'Input.insertText', { text: args.text });
    if (args.submit) await pressKey(tabId, 'Enter');
    return { typed: args.text.length, ...(await pageInfo(tabId)) };
  },

  async press_key(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    for (let i = 0; i < (args.repeat ?? 1); i += 1) await pressKey(tabId, args.keys);
    return { pressed: args.keys };
  },

  async mouse(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    switch (args.action) {
      case 'hover': {
        const point = await targetPoint(tabId, args);
        await mouse(tabId, 'mouseMoved', point);
        return { hovered: point };
      }
      case 'scroll': {
        const hasTarget = args.ref || args.selector || (args.x != null && args.y != null);
        const { cssLayoutViewport: view } = await send(tabId, 'Page.getLayoutMetrics');
        const point = hasTarget ? await targetPoint(tabId, args) : { x: view.clientWidth / 2, y: view.clientHeight / 2 };
        await mouse(tabId, 'mouseWheel', point, { deltaX: args.deltaX ?? 0, deltaY: args.deltaY ?? 0 });
        return { scrolled: { deltaX: args.deltaX ?? 0, deltaY: args.deltaY ?? 0 } };
      }
      case 'drag': {
        const from = await targetPoint(tabId, args.from ?? {});
        const to = await targetPoint(tabId, args.to ?? {});
        const steps = args.steps ?? 12;
        await mouse(tabId, 'mouseMoved', from);
        await mouse(tabId, 'mousePressed', from, { button: 'left', buttons: 1, clickCount: 1 });
        for (let step = 1; step <= steps; step += 1) {
          const point = { x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps };
          await mouse(tabId, 'mouseMoved', point, { button: 'left', buttons: 1 });
        }
        await mouse(tabId, 'mouseReleased', to, { button: 'left', clickCount: 1 });
        return { dragged: { from, to } };
      }
      default:
        throw new Error(`Acción desconocida: ${args.action}`);
    }
  },

  async select_option(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    const element = await resolveElement(tabId, args);
    const selected = await callOnNode(tabId, element, `function (wanted) {
      const option = [...this.options].find((item) => item.value === wanted || item.label === wanted || item.text.trim() === wanted);
      if (!option) throw new Error('Opción no encontrada: ' + wanted);
      this.value = option.value;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return option.value;
    }`, args.value);
    return { selected };
  },

  async evaluate(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    const params = {
      expression: args.expression,
      awaitPromise: args.awaitPromise !== false,
      returnByValue: true,
      userGesture: true,
    };
    let { result, exceptionDetails } = await send(tabId, 'Runtime.evaluate', params);
    // Plain evaluation awaits returned promises, so the fallbacks run only on these parse errors.
    const failure = exceptionDetails?.exception?.description ?? '';
    if (TOP_LEVEL_AWAIT.test(failure)) {
      ({ result, exceptionDetails } = await send(tabId, 'Runtime.evaluate', { ...params, replMode: true }));
    } else if (REDECLARED.test(failure)) {
      const scoped = `(0, eval)(${JSON.stringify(`{${args.expression}\n}`)})`;
      ({ result, exceptionDetails } = await send(tabId, 'Runtime.evaluate', { ...params, expression: scoped }));
    }
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return { type: result.type, value: result.value ?? result.description };
  },

  async inject_script(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    if (args.action === 'remove') {
      await send(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: args.id });
      return { removed: args.id };
    }
    const { identifier } = await send(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source: args.source });
    holdTab(tabId, 'inject');
    return { id: identifier, note: 'Corre en cada carga de esta pestaña mientras siga adjunta.' };
  },

  async wait_for(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    const timeoutMs = args.timeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        if (await condition(tabId, args)) return { satisfied: true, ...(await pageInfo(tabId)) };
      } catch (error) {
        lastError = error;
      }
      await waitTick();
    }
    throw new Error(`Condición no cumplida en ${timeoutMs} ms.${lastError ? ` Último error: ${lastError.message}` : ''}`);
  },

  async dialog(args) {
    const tabId = await resolveTab(args);
    const state = await ensureAttached(tabId);
    if (args.policy) state.dialogPolicy = args.policy;
    if (args.action === 'accept' || args.action === 'dismiss') {
      if (!state.dialog) throw new Error('No hay diálogo abierto');
      await send(tabId, 'Page.handleJavaScriptDialog', { accept: args.action === 'accept', promptText: args.promptText });
    }
    return { dialog: state.dialog, policy: state.dialogPolicy };
  },

  async upload_file(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    const element = await resolveElement(tabId, args);
    try {
      await send(tabId, 'DOM.setFileInputFiles', { files: args.files, backendNodeId: element.backendNodeId }, element.sessionId);
    } catch (error) {
      throw new Error(`${error.message}. Activa "Permitir acceso a URLs de archivo" en chrome://extensions para esta extensión.`);
    }
    return { uploaded: args.files.length };
  },

  async console_logs(args) {
    const tabId = await resolveTab(args);
    const state = await ensureAttached(tabId);
    const levels = args.levels;
    const entries = state.console.filter((entry) => !levels?.length || levels.includes(entry.level));
    const result = { tabId, total: entries.length, entries: entries.slice(-(args.limit ?? 100)) };
    if (args.clear) state.console.length = 0;
    return result;
  },

  async storage(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    const params = [args.kind ?? 'local', args.action ?? 'get', args.key ?? null, args.value ?? null];
    const value = await evaluate(tabId, `(${STORAGE_SCRIPT})(...${JSON.stringify(params)})`);
    return { value };
  },

  async emulate(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    if (args.reset) {
      await send(tabId, 'Emulation.clearDeviceMetricsOverride');
      await send(tabId, 'Emulation.clearGeolocationOverride');
      await send(tabId, 'Emulation.setEmulatedMedia', { features: [] });
      await send(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false });
      await send(tabId, 'Emulation.setCPUThrottlingRate', { rate: 1 });
      releaseTab(tabId, 'emulate');
      return { reset: true };
    }
    const applied = [];
    if (args.viewport) {
      const { width, height, deviceScaleFactor = 1, mobile = false } = args.viewport;
      await send(tabId, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
      applied.push('viewport');
    }
    if (args.userAgent) {
      await send(tabId, 'Emulation.setUserAgentOverride', { userAgent: args.userAgent, acceptLanguage: args.locale });
      applied.push('userAgent');
    }
    if (args.geolocation) {
      await send(tabId, 'Emulation.setGeolocationOverride', { accuracy: 50, ...args.geolocation });
      applied.push('geolocation');
    }
    if (args.timezone) {
      await send(tabId, 'Emulation.setTimezoneOverride', { timezoneId: args.timezone });
      applied.push('timezone');
    }
    if (args.locale) {
      await send(tabId, 'Emulation.setLocaleOverride', { locale: args.locale });
      applied.push('locale');
    }
    if (args.colorScheme) {
      await send(tabId, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: args.colorScheme }] });
      applied.push('colorScheme');
    }
    if (args.touch != null) {
      await send(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: args.touch });
      applied.push('touch');
    }
    if (args.cpuThrottle) {
      await send(tabId, 'Emulation.setCPUThrottlingRate', { rate: args.cpuThrottle });
      applied.push('cpuThrottle');
    }
    holdTab(tabId, 'emulate');
    return { tabId, applied };
  },
};
