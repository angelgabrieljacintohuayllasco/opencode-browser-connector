import { isBlockedUrl, redactDeep, redactUrl, REDACTED } from './policy.js';
import { attachedTabs, detach, drainEvents, ensureAttached, send, subscribe, unsubscribeAll } from './cdp.js';
import { assertAllowedUrl, resolveTab, session, settings } from './state.js';

const GROUP_TITLE = 'OpenCode';
const NAVIGATE_TIMEOUT_MS = 30_000;
const SESSION_RULE_BASE = 1000;

let agentGroupId = null;
let nextGlobalRuleId = SESSION_RULE_BASE;

function describeTab(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    status: tab.status,
    attached: attachedTabs().includes(tab.id) || undefined,
    current: tab.id === session.currentTabId || undefined,
  };
}

async function addToAgentGroup(tabId) {
  try {
    if (agentGroupId != null) {
      const exists = await chrome.tabGroups.get(agentGroupId).catch(() => null);
      if (!exists) agentGroupId = null;
    }
    agentGroupId = await chrome.tabs.group(agentGroupId != null ? { tabIds: tabId, groupId: agentGroupId } : { tabIds: tabId });
    await chrome.tabGroups.update(agentGroupId, { title: GROUP_TITLE, color: 'orange', collapsed: false });
  } catch {
    agentGroupId = null;
  }
}

function waitForLoad(tabId, timeoutMs = NAVIGATE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`La navegación no terminó en ${timeoutMs} ms`));
    }, timeoutMs);
    let navigationError;
    const onUpdated = (updatedId, change) => {
      if (updatedId === tabId && change.status === 'complete') {
        finish();
        if (navigationError) reject(new Error(`Navegación falló: ${navigationError}`));
        else resolve();
      }
    };
    const onError = (details) => {
      if (details.tabId === tabId && details.frameId === 0 && details.error !== 'net::ERR_ABORTED') {
        navigationError = details.error;
      }
    };
    const finish = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.webNavigation.onErrorOccurred.removeListener(onError);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.webNavigation.onErrorOccurred.addListener(onError);
  });
}

async function navigateTab(tabId, change, timeoutMs) {
  const loaded = waitForLoad(tabId, timeoutMs);
  await change();
  await loaded;
  return describeTab(await chrome.tabs.get(tabId));
}

async function tabAction(args) {
  switch (args.action) {
    case 'list': {
      const allTabs = await chrome.tabs.query({});
      return { tabs: allTabs.filter((tab) => !isBlockedUrl(tab.url, settings.blockedDomains)).map(describeTab) };
    }
    case 'new': {
      if (args.url) assertAllowedUrl(args.url);
      const tab = await createTab({ url: args.url ?? 'about:blank', active: args.active ?? false, windowId: args.windowId });
      session.currentTabId = tab.id;
      await addToAgentGroup(tab.id);
      return describeTab(await chrome.tabs.get(tab.id));
    }
    case 'select': {
      const tabId = await resolveTab(args);
      if (args.activate) {
        await chrome.tabs.update(tabId, { active: true });
        const tab = await chrome.tabs.get(tabId);
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return describeTab(await chrome.tabs.get(tabId));
    }
    case 'close': {
      const tabId = await resolveTab(args);
      await chrome.tabs.remove(tabId);
      if (session.currentTabId === tabId) session.currentTabId = null;
      return { closed: tabId };
    }
    case 'reload': {
      const tabId = await resolveTab(args);
      return navigateTab(tabId, () => chrome.tabs.reload(tabId, { bypassCache: Boolean(args.bypassCache) }));
    }
    case 'back':
    case 'forward': {
      const tabId = await resolveTab(args);
      return navigateTab(tabId, () => (args.action === 'back' ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId)));
    }
    case 'detach': {
      const tabId = await resolveTab(args);
      await detach(tabId);
      return { detached: tabId };
    }
    default:
      throw new Error(`Acción desconocida: ${args.action}`);
  }
}

async function windowAction(args) {
  switch (args.action) {
    case 'list':
      return { windows: await chrome.windows.getAll({ populate: false }) };
    case 'new':
      if (args.url) assertAllowedUrl(args.url);
      return chrome.windows.create({ url: args.url, incognito: args.incognito, state: args.state });
    case 'update':
      return chrome.windows.update(args.windowId, {
        focused: args.focused,
        state: args.state,
        left: args.left,
        top: args.top,
        width: args.width,
        height: args.height,
      });
    case 'close':
      await chrome.windows.remove(args.windowId);
      return { closed: args.windowId };
    default:
      throw new Error(`Acción desconocida: ${args.action}`);
  }
}

function cookieUrl(cookie) {
  const host = cookie.domain.replace(/^\./, '');
  return `http${cookie.secure ? 's' : ''}://${host}${cookie.path}`;
}

function cookieAllowed(cookie) {
  return !isBlockedUrl(`https://${cookie.domain.replace(/^\./, '')}/`, settings.blockedDomains);
}

function protectCookie(cookie) {
  return settings.redactSecrets ? { ...cookie, value: `${REDACTED} (${cookie.value.length} chars)` } : cookie;
}

async function cookieAction(args) {
  const filter = {};
  for (const key of ['url', 'domain', 'name', 'path']) if (args[key]) filter[key] = args[key];
  switch (args.action) {
    case 'list': {
      const cookies = (await chrome.cookies.getAll(filter)).filter(cookieAllowed);
      return { total: cookies.length, cookies: cookies.slice(0, args.limit ?? 200).map(protectCookie) };
    }
    case 'set': {
      if (!args.url) throw new Error('set requiere url');
      assertAllowedUrl(args.url);
      const details = { url: args.url, name: args.name, value: args.value };
      for (const key of ['domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expirationDate']) {
        if (args[key] !== undefined) details[key] = args[key];
      }
      return protectCookie(await chrome.cookies.set(details));
    }
    case 'delete': {
      if (!Object.keys(filter).length) throw new Error('delete requiere url, domain o name');
      const cookies = (await chrome.cookies.getAll(filter)).filter(cookieAllowed);
      await Promise.all(cookies.map((cookie) => chrome.cookies.remove({ url: cookieUrl(cookie), name: cookie.name })));
      return { deleted: cookies.length };
    }
    default:
      throw new Error(`Acción desconocida: ${args.action}`);
  }
}

function toDnrRule(id, rule) {
  const action = { type: rule.action };
  if (rule.action === 'redirect') action.redirect = { url: rule.redirectUrl };
  if (rule.action === 'modifyHeaders') {
    if (rule.requestHeaders) action.requestHeaders = rule.requestHeaders;
    if (rule.responseHeaders) action.responseHeaders = rule.responseHeaders;
  }
  const condition = {};
  if (rule.urlFilter) condition.urlFilter = rule.urlFilter;
  if (rule.regexFilter) condition.regexFilter = rule.regexFilter;
  if (rule.resourceTypes) condition.resourceTypes = rule.resourceTypes;
  if (rule.domains) condition.requestDomains = rule.domains;
  return { id, priority: rule.priority ?? 1, action, condition };
}

async function globalRuleAction(args) {
  const { updateSessionRules, getSessionRules } = chrome.declarativeNetRequest;
  switch (args.action) {
    case 'add': {
      const id = nextGlobalRuleId;
      nextGlobalRuleId += 1;
      await updateSessionRules({ addRules: [toDnrRule(id, args.rule)] });
      return { id };
    }
    case 'remove':
      await updateSessionRules({ removeRuleIds: [args.id] });
      return { removed: args.id };
    case 'clear': {
      const existing = await getSessionRules();
      await updateSessionRules({ removeRuleIds: existing.map((rule) => rule.id) });
      return { removed: existing.length };
    }
    default:
      return { rules: await getSessionRules() };
  }
}

async function browserData(args) {
  switch (args.kind) {
    case 'history': {
      const startTime = Date.now() - (args.days ?? 7) * 86_400_000;
      const items = await chrome.history.search({ text: args.query ?? '', startTime, maxResults: args.limit ?? 50 });
      return { items: items.filter((item) => !isBlockedUrl(item.url, settings.blockedDomains)).map((item) => ({ ...item, url: settings.redactSecrets ? redactUrl(item.url) : item.url })) };
    }
    case 'bookmarks':
      return { items: (await chrome.bookmarks.search(args.query ?? {})).slice(0, args.limit ?? 50) };
    case 'add_bookmark':
      return chrome.bookmarks.create({ title: args.title, url: args.url, parentId: args.parentId });
    case 'downloads':
      return { items: await chrome.downloads.search({ query: args.query ? [args.query] : undefined, limit: args.limit ?? 50, orderBy: ['-startTime'] }) };
    case 'download':
      assertAllowedUrl(args.url);
      return { downloadId: await chrome.downloads.download({ url: args.url, filename: args.filename, saveAs: false }) };
    case 'extensions':
      return { items: (await chrome.management.getAll()).map(({ id, name, version, enabled, type }) => ({ id, name, version, enabled, type })) };
    case 'set_extension_enabled':
      await chrome.management.setEnabled(args.id, Boolean(args.enabled));
      return { id: args.id, enabled: Boolean(args.enabled) };
    case 'clear_site_data': {
      if (!args.origin) throw new Error('clear_site_data requiere origin, por ejemplo https://example.com');
      await chrome.browsingData.remove({ origins: [args.origin] }, { cookies: true, cache: true, localStorage: true, indexedDB: true, serviceWorkers: true, cacheStorage: true });
      return { cleared: args.origin };
    }
    default:
      throw new Error(`Tipo desconocido: ${args.kind}`);
  }
}

// Never reuses the user's own tab unless the agent asked for that tab by id.
async function agentTab(args) {
  if (args.tabId != null) return resolveTab(args);
  const current = session.currentTabId;
  const exists = current != null && (await chrome.tabs.get(current).catch(() => null));
  if (exists) return resolveTab({ tabId: current });
  const tab = await createTab({ url: 'about:blank', active: false });
  await addToAgentGroup(tab.id);
  return tab.id;
}

async function createTab(properties) {
  const [window] = await chrome.windows.getAll();
  if (window) return chrome.tabs.create(properties);
  const created = await chrome.windows.create({ url: properties.url });
  return created.tabs[0];
}

export const browserHandlers = {
  tabs: tabAction,
  windows: windowAction,
  cookies: cookieAction,
  global_rules: globalRuleAction,
  browser_data: browserData,

  async navigate(args) {
    assertAllowedUrl(args.url);
    const tabId = await agentTab(args);
    session.currentTabId = tabId;
    return navigateTab(tabId, () => chrome.tabs.update(tabId, { url: args.url }), args.timeoutMs);
  },

  async cdp(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    const result = await send(tabId, args.method, args.params ?? {}, args.sessionId, args.timeoutMs);
    return settings.redactSecrets ? redactDeep(result) : result;
  },

  async cdp_events(args) {
    switch (args.action) {
      case 'subscribe':
        subscribe(args.methods ?? ['*']);
        return { subscribed: args.methods ?? ['*'] };
      case 'clear':
        unsubscribeAll();
        return { cleared: true };
      default: {
        const events = drainEvents(args.limit ?? 100);
        return { events: settings.redactSecrets ? redactDeep(events) : events };
      }
    }
  },
};
