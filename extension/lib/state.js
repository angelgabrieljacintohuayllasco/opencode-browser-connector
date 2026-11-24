import { isBlockedUrl, isProtectedUrl } from './policy.js';

const DEFAULTS = {
  enabled: true,
  redactSecrets: true,
  blockedDomains: [
    'viabcp.com',
    'bbva.pe',
    'interbank.pe',
    'scotiabank.com.pe',
    'bn.com.pe',
    'paypal.com',
    'binance.com',
    '1password.com',
    'bitwarden.com',
    'passwords.google.com',
  ],
};

const LOG_LIMIT = 200;

export const settings = { ...DEFAULTS };
export const session = { currentTabId: null };
export const activity = [];

export async function loadSettings() {
  Object.assign(settings, await chrome.storage.local.get(DEFAULTS));
}

export async function saveSettings(patch) {
  Object.assign(settings, patch);
  await chrome.storage.local.set(patch);
}

export function record(tool, detail, ok) {
  activity.unshift({ at: Date.now(), tool, detail: String(detail ?? '').slice(0, 120), ok });
  activity.length = Math.min(activity.length, LOG_LIMIT);
}

export function isForbiddenUrl(url) {
  return isProtectedUrl(url) || isBlockedUrl(url, settings.blockedDomains);
}

export function assertAllowedUrl(url) {
  if (isProtectedUrl(url)) {
    throw new Error('Las páginas de extensiones están protegidas: los ajustes del conector solo los cambia el usuario.');
  }
  if (isBlockedUrl(url, settings.blockedDomains)) {
    throw new Error(`Dominio bloqueado por la lista del conector: ${new URL(url).hostname}. Solo el usuario puede quitarlo desde el popup.`);
  }
}

export async function resolveTab(args = {}) {
  const tabId = args.tabId ?? session.currentTabId ?? (await activeTabId());
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    if (args.tabId != null) throw new Error(`No existe la pestaña ${tabId}`);
    session.currentTabId = null;
    tab = await chrome.tabs.get(await activeTabId());
  }
  if (tab.url) assertAllowedUrl(tab.url);
  session.currentTabId = tab.id;
  return tab.id;
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) return tab.id;
  const [any] = await chrome.tabs.query({});
  if (!any) throw new Error('No hay pestañas abiertas');
  return any.id;
}
