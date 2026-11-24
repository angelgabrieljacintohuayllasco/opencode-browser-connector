// Pure helpers with no chrome.* access, so they can be unit tested in Node.

const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
]);

const SECRET_FIELD = 'pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key|authorization|session[_-]?id|otp|pin|cvv|cvc';
const SECRET_JSON = new RegExp(`("(?:[^"]*(?:${SECRET_FIELD})[^"]*)"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi');
const SECRET_FORM = new RegExp(`((?:^|&)[^=&]*(?:${SECRET_FIELD})[^=&]*=)[^&]*`, 'gi');

export const REDACTED = '[redacted]';

export function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

export function hostMatches(host, pattern) {
  const h = String(host).toLowerCase();
  const p = String(pattern).trim().toLowerCase().replace(/^\*\./, '');
  return Boolean(p) && (h === p || h.endsWith(`.${p}`));
}

export function isBlockedUrl(url, blockedDomains) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return blockedDomains.some((domain) => hostMatches(host, domain));
}

export function isProtectedUrl(url) {
  return /^(chrome-extension|chrome|edge|devtools):/i.test(String(url).trim()) && !/^chrome:\/\/newtab/i.test(String(url).trim());
}

export function redactHeaders(headers) {
  if (!headers) return headers;
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SECRET_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

function redactHeaderList(list) {
  return list.map((item) => (SECRET_HEADERS.has(String(item.name).toLowerCase()) ? { ...item, value: REDACTED } : item));
}

function isHeaderList(value) {
  return Array.isArray(value) && value.every((item) => item && typeof item.name === 'string' && 'value' in item);
}

// Covers raw CDP payloads, whose shape varies by method.
export function redactDeep(value) {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'headersText' || key === 'requestHeadersText') out[key] = REDACTED;
    else if (/cookie/i.test(key) && key !== 'cookies') out[key] = REDACTED;
    else if (/headers$/i.test(key) && isHeaderList(item)) out[key] = redactHeaderList(item);
    else if (/headers$/i.test(key) && item && typeof item === 'object') out[key] = redactHeaders(item);
    else if (key === 'cookies' && Array.isArray(item)) out[key] = item.map((cookie) => ({ ...cookie, value: REDACTED }));
    else if (key === 'postDataEntries') out[key] = REDACTED;
    else if (['postData', 'body', 'payloadData'].includes(key) && typeof item === 'string') out[key] = redactBody(item);
    else if (['url', 'documentURL'].includes(key) && typeof item === 'string') out[key] = redactUrl(item);
    else out[key] = redactDeep(item);
  }
  return out;
}

export function redactBody(text) {
  if (typeof text !== 'string') return text;
  return text.replace(SECRET_JSON, `$1"${REDACTED}"`).replace(SECRET_FORM, `$1${REDACTED}`);
}

export function redactUrl(url) {
  const queryStart = String(url).indexOf('?');
  if (queryStart < 0) return url;
  return url.slice(0, queryStart + 1) + redactBody(url.slice(queryStart + 1));
}

export function matchRule(rule, request) {
  if (rule.tabId != null && rule.tabId !== request.tabId) return false;
  if ((rule.stage || 'request') !== request.stage) return false;
  if (rule.method && rule.method.toUpperCase() !== request.method) return false;
  if (rule.resourceTypes?.length && !rule.resourceTypes.includes(request.resourceType)) return false;
  if (rule.regex) return new RegExp(rule.regex, 'i').test(request.url);
  return globToRegExp(rule.url || '*').test(request.url);
}

export function applyReplacements(text, replacements = []) {
  let out = text;
  for (const { find, replace = '', regex } of replacements) {
    out = regex ? out.replace(new RegExp(find, 'g'), replace) : out.split(find).join(replace);
  }
  return out;
}

export function mergeHeaders(existing, setHeaders = {}, removeHeaders = []) {
  const removed = new Set(removeHeaders.map((name) => name.toLowerCase()));
  const overrides = new Map(Object.entries(setHeaders).map(([k, v]) => [k.toLowerCase(), [k, v]]));
  const out = [];
  for (const { name, value } of existing) {
    const key = name.toLowerCase();
    if (removed.has(key) || overrides.has(key)) continue;
    out.push({ name, value });
  }
  for (const [name, value] of overrides.values()) {
    if (value != null) out.push({ name, value: String(value) });
  }
  return out;
}

export function headersToList(headers = {}) {
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToUtf8(base64) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const NAMED_KEYS = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};

const MODIFIERS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, win: 4, shift: 8 };
const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };

function describeKey(name) {
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named) return named;
  const fn = /^f(\d{1,2})$/i.exec(name);
  if (fn) return { key: name.toUpperCase(), code: name.toUpperCase(), vk: 111 + Number(fn[1]) };
  if (name.length !== 1) throw new Error(`Tecla desconocida: ${name}`);
  const upper = name.toUpperCase();
  const isLetter = /[A-Z]/.test(upper);
  const isDigit = /[0-9]/.test(name);
  return {
    key: name,
    code: isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : '',
    vk: isLetter || isDigit ? upper.charCodeAt(0) : 0,
    text: name,
  };
}

export function parseKeyCombo(combo) {
  const parts = String(combo).split('+').map((part) => part.trim()).filter(Boolean);
  if (combo.endsWith('+') && !parts.at(-1)?.endsWith('+')) parts.push('+');
  if (!parts.length) throw new Error('Combinación de teclas vacía');
  const keyName = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part.toLowerCase()];
    if (!bit) throw new Error(`Modificador desconocido: ${part}`);
    modifiers |= bit;
  }
  const key = describeKey(keyName);
  const usesShortcut = (modifiers & 2) !== 0 || (modifiers & 4) !== 0;
  const command = usesShortcut ? EDIT_COMMANDS[keyName.toLowerCase()] : undefined;
  return {
    ...key,
    text: usesShortcut ? undefined : key.text,
    modifiers,
    commands: command ? [command] : undefined,
  };
}
