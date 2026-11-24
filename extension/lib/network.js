import {
  applyReplacements,
  base64ToUtf8,
  headersToList,
  isBlockedUrl,
  matchRule,
  mergeHeaders,
  redactBody,
  redactHeaders,
  redactUrl,
  utf8ToBase64,
  globToRegExp,
} from './policy.js';
import {
  attachedTabs,
  childSessions,
  ensureAttached,
  holdTab,
  onCdpEvent,
  onSessionAttached,
  onTabDetached,
  releaseTab,
  send,
} from './cdp.js';
import { assertAllowedUrl, resolveTab, settings } from './state.js';

const MAX_ENTRIES = 3000;
const MAX_BODY_BYTES = 2_000_000;
const MAX_STORED_BYTES = 64_000_000;
const MAX_WS_FRAMES = 2000;
const DEFAULT_HOLD_MS = 60_000;
const STRIPPED_ON_REWRITE = ['content-length', 'content-encoding', 'transfer-encoding'];

const captures = new Map();
const rules = new Map();
const paused = new Map();
let nextRuleId = 1;
let nextPausedId = 1;

function captureFor(tabId) {
  let capture = captures.get(tabId);
  if (!capture) {
    capture = { tabId, active: false, captureBodies: false, entries: new Map(), wsFrames: [], storedBytes: 0 };
    captures.set(tabId, capture);
  }
  return capture;
}

function evict(capture) {
  while (capture.entries.size > MAX_ENTRIES) {
    const [oldestKey, oldest] = capture.entries.entries().next().value;
    capture.storedBytes -= oldest.body?.length ?? 0;
    capture.entries.delete(oldestKey);
  }
}

function headersFromObject(headers) {
  return headers ? { ...headers } : undefined;
}

function entryFor(capture, requestId, redirectIndex = 0) {
  return capture.entries.get(`${requestId}:${redirectIndex}`);
}

function latestEntry(capture, requestId) {
  let found;
  for (let index = 0; ; index += 1) {
    const entry = entryFor(capture, requestId, index);
    if (!entry) return found;
    found = entry;
  }
}

function addEntry(capture, sessionId, params) {
  const { requestId, request, type, wallTime, timestamp, initiator, documentURL } = params;
  let redirectIndex = 0;
  while (entryFor(capture, requestId, redirectIndex)) redirectIndex += 1;
  if (redirectIndex > 0 && params.redirectResponse) {
    Object.assign(entryFor(capture, requestId, redirectIndex - 1), {
      status: params.redirectResponse.status,
      statusText: params.redirectResponse.statusText,
      responseHeaders: headersFromObject(params.redirectResponse.headers),
      finished: true,
    });
  }
  const id = `${requestId}:${redirectIndex}`;
  capture.entries.set(id, {
    id,
    requestId,
    sessionId,
    tabId: capture.tabId,
    method: request.method,
    url: request.url,
    type,
    documentURL,
    initiator: initiator?.type,
    requestHeaders: headersFromObject(request.headers),
    postData: request.postData,
    hasPostData: request.hasPostData,
    startedAt: wallTime * 1000,
    startTimestamp: timestamp,
    finished: false,
  });
  evict(capture);
}

async function storeBody(capture, entry, encodedLength) {
  if (!capture.captureBodies || encodedLength > MAX_BODY_BYTES || capture.storedBytes > MAX_STORED_BYTES) return;
  try {
    const { body, base64Encoded } = await send(capture.tabId, 'Network.getResponseBody', { requestId: entry.requestId }, entry.sessionId);
    entry.body = body;
    entry.bodyBase64 = base64Encoded;
    capture.storedBytes += body.length;
  } catch {
    entry.bodyUnavailable = true;
  }
}

function onNetworkEvent(tabId, sessionId, method, params) {
  const capture = captures.get(tabId);
  if (!capture?.active) return;
  switch (method) {
    case 'Network.requestWillBeSent':
      addEntry(capture, sessionId, params);
      break;
    case 'Network.requestWillBeSentExtraInfo': {
      const entry = latestEntry(capture, params.requestId);
      if (entry) entry.requestHeaders = { ...entry.requestHeaders, ...params.headers };
      break;
    }
    case 'Network.responseReceived': {
      const entry = latestEntry(capture, params.requestId);
      if (!entry) break;
      const { response } = params;
      Object.assign(entry, {
        status: response.status,
        statusText: response.statusText,
        mimeType: response.mimeType,
        protocol: response.protocol,
        remoteIP: response.remoteIPAddress,
        fromCache: response.fromDiskCache || response.fromServiceWorker,
        responseHeaders: { ...entry.responseHeaders, ...headersFromObject(response.headers) },
      });
      break;
    }
    case 'Network.responseReceivedExtraInfo': {
      const entry = latestEntry(capture, params.requestId);
      if (entry) entry.responseHeaders = { ...entry.responseHeaders, ...params.headers };
      break;
    }
    case 'Network.loadingFinished': {
      const entry = latestEntry(capture, params.requestId);
      if (!entry) break;
      entry.finished = true;
      entry.encodedSize = params.encodedDataLength;
      entry.durationMs = Math.round((params.timestamp - entry.startTimestamp) * 1000);
      storeBody(capture, entry, params.encodedDataLength);
      break;
    }
    case 'Network.loadingFailed': {
      const entry = latestEntry(capture, params.requestId);
      if (!entry) break;
      Object.assign(entry, { finished: true, failed: params.errorText, canceled: params.canceled, blockedReason: params.blockedReason });
      break;
    }
    case 'Network.webSocketCreated':
      capture.wsFrames.push({ at: Date.now(), event: 'open', socket: params.requestId, url: params.url });
      break;
    case 'Network.webSocketFrameSent':
    case 'Network.webSocketFrameReceived':
      capture.wsFrames.push({
        at: Date.now(),
        event: method.endsWith('Sent') ? 'sent' : 'received',
        socket: params.requestId,
        opcode: params.response.opcode,
        data: params.response.payloadData,
      });
      break;
    case 'Network.webSocketClosed':
      capture.wsFrames.push({ at: Date.now(), event: 'close', socket: params.requestId });
      break;
    case 'Network.eventSourceMessageReceived':
      capture.wsFrames.push({ at: Date.now(), event: 'sse', socket: params.requestId, data: params.data, name: params.eventName });
      break;
    default:
      return;
  }
  if (capture.wsFrames.length > MAX_WS_FRAMES) capture.wsFrames.shift();
}

function rulesForTab(tabId) {
  return [...rules.values()].filter((rule) => rule.allTabs || rule.tabId === tabId);
}

function fetchPatterns(tabId) {
  return rulesForTab(tabId).map((rule) => {
    const pattern = { urlPattern: rule.regex ? '*' : rule.url || '*', requestStage: rule.stage === 'response' ? 'Response' : 'Request' };
    return pattern;
  });
}

async function syncFetch(tabId, sessionId) {
  const patterns = fetchPatterns(tabId);
  if (patterns.length) {
    await send(tabId, 'Fetch.enable', { patterns }, sessionId);
  } else {
    await send(tabId, 'Fetch.disable', {}, sessionId).catch(() => {});
  }
}

async function syncFetchEverywhere(tabId) {
  await syncFetch(tabId);
  for (const child of childSessions(tabId)) await syncFetch(tabId, child.sessionId).catch(() => {});
  const hasWork = rulesForTab(tabId).length > 0;
  (hasWork ? holdTab : releaseTab)(tabId, 'intercept');
}

function continueRequest(tabId, sessionId, requestId) {
  return send(tabId, 'Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
}

function fulfillParams(requestId, spec, fallbackHeaders = []) {
  const body = spec.bodyBase64 ?? (spec.body != null ? utf8ToBase64(spec.body) : undefined);
  const headers = spec.headers ? headersToList(spec.headers) : fallbackHeaders;
  const responseCode = spec.status ?? 200;
  return { requestId, responseCode, responsePhrase: reasonPhrase(responseCode, spec.statusText), responseHeaders: headers, ...(body != null && { body }) };
}

// Chrome rejects non-standard status codes unless a phrase is supplied.
function reasonPhrase(status, given) {
  return given ?? (status < 400 ? 'OK' : 'Error');
}

async function readPausedBody(tabId, sessionId, requestId) {
  const { body, base64Encoded } = await send(tabId, 'Fetch.getResponseBody', { requestId }, sessionId);
  return base64Encoded ? base64ToUtf8(body) : body;
}

async function modifyResponse(tabId, sessionId, event, modify) {
  const { requestId, responseStatusCode, responseHeaders = [] } = event;
  const needsBody = modify.replaceBody?.length || modify.body != null;
  const stripped = needsBody ? [...(modify.removeHeaders ?? []), ...STRIPPED_ON_REWRITE] : modify.removeHeaders;
  const headers = mergeHeaders(responseHeaders, modify.setHeaders, stripped);
  const status = modify.status ?? responseStatusCode;
  const responsePhrase = reasonPhrase(status, modify.statusText ?? (modify.status ? undefined : event.responseStatusText || undefined));
  const response = { requestId, responseCode: status, responsePhrase, responseHeaders: headers };
  if (!needsBody) {
    await send(tabId, 'Fetch.continueResponse', response, sessionId);
    return;
  }
  const original = modify.body ?? (await readPausedBody(tabId, sessionId, requestId));
  const body = utf8ToBase64(applyReplacements(original, modify.replaceBody));
  await send(tabId, 'Fetch.fulfillRequest', { ...response, body }, sessionId);
}

function pausedPostData(request) {
  if (request.postData != null) return request.postData;
  if (!request.postDataEntries?.length) return undefined;
  return request.postDataEntries.map((entry) => (entry.bytes ? base64ToUtf8(entry.bytes) : '')).join('');
}

function modifyRequest(tabId, sessionId, event, modify) {
  const { requestId, request } = event;
  const existing = Object.entries(request.headers).map(([name, value]) => ({ name, value }));
  const params = { requestId };
  if (modify.url) params.url = modify.url;
  if (modify.method) params.method = modify.method;
  if (modify.setHeaders || modify.removeHeaders) params.headers = mergeHeaders(existing, modify.setHeaders, modify.removeHeaders);
  const original = pausedPostData(request);
  if (modify.body != null) params.postData = utf8ToBase64(modify.body);
  else if (modify.replaceBody?.length && original != null) params.postData = utf8ToBase64(applyReplacements(original, modify.replaceBody));
  return send(tabId, 'Fetch.continueRequest', params, sessionId);
}

function holdRequest(tabId, sessionId, event, rule) {
  const id = nextPausedId;
  nextPausedId += 1;
  const timeoutMs = rule.holdMs ?? DEFAULT_HOLD_MS;
  const timer = setTimeout(() => {
    paused.delete(id);
    continueRequest(tabId, sessionId, event.requestId);
  }, timeoutMs);
  paused.set(id, { id, tabId, sessionId, event, rule: rule.id, timer, expiresAt: Date.now() + timeoutMs });
}

async function applyRule(tabId, sessionId, event, rule, stage) {
  const { requestId } = event;
  switch (rule.action) {
    case 'block':
      await send(tabId, 'Fetch.failRequest', { requestId, errorReason: rule.errorReason ?? 'BlockedByClient' }, sessionId);
      break;
    case 'fulfill':
      await send(tabId, 'Fetch.fulfillRequest', fulfillParams(requestId, rule), sessionId);
      break;
    case 'modify':
      if (stage === 'response') await modifyResponse(tabId, sessionId, event, rule.modify ?? {});
      else await modifyRequest(tabId, sessionId, event, rule.modify ?? {});
      break;
    case 'hold':
      holdRequest(tabId, sessionId, event, rule);
      break;
    default:
      await continueRequest(tabId, sessionId, requestId);
  }
}

function isRedirect(event) {
  return event.responseStatusCode >= 300 && event.responseStatusCode < 400;
}

async function onRequestPaused(tabId, sessionId, event) {
  const stage = event.responseStatusCode != null || event.responseErrorReason ? 'response' : 'request';
  const candidate = {
    tabId,
    stage,
    url: event.request.url,
    method: event.request.method,
    resourceType: event.resourceType,
  };
  const rule = rulesForTab(tabId).find((item) => matchRule({ ...item, tabId: undefined }, candidate));
  if (!rule || (stage === 'response' && isRedirect(event) && rule.action === 'modify')) {
    await continueRequest(tabId, sessionId, event.requestId);
    return;
  }
  rule.hits += 1;
  if (rule.times != null && rule.hits >= rule.times) removeRule(rule.id);
  try {
    await applyRule(tabId, sessionId, event, rule, stage);
  } catch (error) {
    rule.lastError = error.message;
    await continueRequest(tabId, sessionId, event.requestId);
  }
}

function removeRule(id) {
  const rule = rules.get(id);
  rules.delete(id);
  if (!rule) return;
  queueMicrotask(() => {
    for (const tabId of attachedTabs()) syncFetchEverywhere(tabId).catch(() => {});
  });
}

function releasePaused(filter) {
  for (const item of paused.values()) {
    if (filter(item)) {
      clearTimeout(item.timer);
      paused.delete(item.id);
      continueRequest(item.tabId, item.sessionId, item.event.requestId);
    }
  }
}

onCdpEvent((tabId, sessionId, method, params) => {
  if (method === 'Fetch.requestPaused') onRequestPaused(tabId, sessionId, params);
  else if (method.startsWith('Network.')) onNetworkEvent(tabId, sessionId, method, params);
});

onSessionAttached(async (tabId, sessionId) => {
  if (rulesForTab(tabId).length) await syncFetch(tabId, sessionId);
});

onTabDetached((tabId) => {
  for (const [id, item] of paused) {
    if (item.tabId === tabId) {
      clearTimeout(item.timer);
      paused.delete(id);
    }
  }
  const capture = captures.get(tabId);
  if (capture) capture.active = false;
});

export function networkSummary() {
  return {
    rules: rules.size,
    paused: paused.size,
    capturing: [...captures.values()].filter((capture) => capture.active).map((capture) => capture.tabId),
  };
}

export function resetNetwork() {
  releasePaused(() => true);
  rules.clear();
  for (const capture of captures.values()) capture.active = false;
}

export async function attachForAllTabsRules(tabId) {
  if (![...rules.values()].some((rule) => rule.allTabs)) return;
  await ensureAttached(tabId);
  await syncFetchEverywhere(tabId);
}

function listItem(entry) {
  return {
    id: entry.id,
    method: entry.method,
    url: settings.redactSecrets ? redactUrl(entry.url) : entry.url,
    type: entry.type,
    status: entry.status,
    mimeType: entry.mimeType,
    size: entry.encodedSize,
    ms: entry.durationMs,
    failed: entry.failed,
    pending: !entry.finished || undefined,
  };
}

function protect(entry) {
  if (!settings.redactSecrets) return entry;
  return {
    ...entry,
    url: redactUrl(entry.url),
    requestHeaders: redactHeaders(entry.requestHeaders),
    responseHeaders: redactHeaders(entry.responseHeaders),
    postData: redactBody(entry.postData),
  };
}

async function resolveEntry(tabId, id) {
  const capture = captures.get(tabId);
  const entry = capture?.entries.get(id) ?? (capture && latestEntry(capture, id));
  if (!entry) throw new Error(`No hay request capturado con id ${id}`);
  if (entry.hasPostData && entry.postData == null) {
    entry.postData = await send(tabId, 'Network.getRequestPostData', { requestId: entry.requestId }, entry.sessionId)
      .then((result) => result.postData)
      .catch(() => undefined);
  }
  return entry;
}

async function responseBody(tabId, entry) {
  if (entry.body != null) return { body: entry.body, base64Encoded: entry.bodyBase64 };
  return send(tabId, 'Network.getResponseBody', { requestId: entry.requestId }, entry.sessionId);
}

function toHarEntry(entry) {
  const safe = protect(entry);
  const toList = (headers = {}) => Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
  const { searchParams } = new URL(safe.url);
  const content = { size: entry.encodedSize ?? 0, mimeType: entry.mimeType ?? '' };
  if (entry.body != null) {
    content.text = entry.bodyBase64 || !settings.redactSecrets ? entry.body : redactBody(entry.body);
    if (entry.bodyBase64) content.encoding = 'base64';
  }
  return {
    startedDateTime: new Date(entry.startedAt).toISOString(),
    time: entry.durationMs ?? 0,
    request: {
      method: entry.method,
      url: safe.url,
      httpVersion: entry.protocol ?? '',
      headers: toList(safe.requestHeaders),
      queryString: [...searchParams].map(([name, value]) => ({ name, value })),
      cookies: [],
      headersSize: -1,
      bodySize: entry.postData?.length ?? 0,
      ...(safe.postData != null && { postData: { mimeType: entry.requestHeaders?.['Content-Type'] ?? '', text: safe.postData } }),
    },
    response: {
      status: entry.status ?? 0,
      statusText: entry.statusText ?? '',
      httpVersion: entry.protocol ?? '',
      headers: toList(safe.responseHeaders),
      cookies: [],
      content,
      redirectURL: entry.responseHeaders?.location ?? '',
      headersSize: -1,
      bodySize: entry.encodedSize ?? -1,
    },
    cache: {},
    timings: { send: 0, wait: entry.durationMs ?? 0, receive: 0 },
  };
}

export const networkHandlers = {
  async network_capture(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    const capture = captureFor(tabId);
    switch (args.action) {
      case 'start':
        capture.active = true;
        capture.captureBodies = Boolean(args.captureBodies);
        holdTab(tabId, 'capture');
        break;
      case 'stop':
        capture.active = false;
        releaseTab(tabId, 'capture');
        break;
      case 'clear':
        capture.entries.clear();
        capture.wsFrames.length = 0;
        capture.storedBytes = 0;
        break;
      default:
    }
    return { tabId, active: capture.active, captureBodies: capture.captureBodies, entries: capture.entries.size, wsFrames: capture.wsFrames.length };
  },

  async network_list(args) {
    const tabId = await resolveTab(args);
    const capture = captures.get(tabId);
    if (!capture) return { tabId, total: 0, requests: [], hint: 'Primero llama network_capture con action=start.' };
    const urlTest = args.url ? (args.url.includes('*') ? globToRegExp(args.url) : null) : null;
    const matches = [...capture.entries.values()].filter((entry) => {
      if (urlTest && !urlTest.test(entry.url)) return false;
      if (args.url && !urlTest && !entry.url.includes(args.url)) return false;
      if (args.method && entry.method !== args.method.toUpperCase()) return false;
      if (args.type && entry.type !== args.type) return false;
      if (args.status != null && entry.status !== args.status) return false;
      if (args.failedOnly && !entry.failed && !(entry.status >= 400)) return false;
      return true;
    });
    const limit = args.limit ?? 100;
    return { tabId, total: matches.length, requests: matches.slice(-limit).map(listItem) };
  },

  async network_get(args) {
    const tabId = await resolveTab(args);
    const entry = await resolveEntry(tabId, args.id);
    const { body: _body, sessionId: _session, ...rest } = protect(entry);
    const result = { ...rest };
    if (args.includeBody !== false) {
      const maxBody = args.maxBody ?? 20_000;
      try {
        const { body, base64Encoded } = await responseBody(tabId, entry);
        if (base64Encoded) {
          result.body = args.includeBinary ? body.slice(0, maxBody) : `[binario ${body.length} chars base64]`;
          result.bodyEncoding = 'base64';
        } else {
          const text = settings.redactSecrets ? redactBody(body) : body;
          result.body = text.slice(0, maxBody);
          result.bodyTruncated = text.length > maxBody || undefined;
        }
      } catch (error) {
        result.bodyError = error.message;
      }
    }
    return result;
  },

  async network_export_har(args) {
    const tabId = await resolveTab(args);
    const capture = captures.get(tabId);
    if (!capture) throw new Error('No hay captura en esta pestaña');
    const entries = [...capture.entries.values()].filter((entry) => entry.startedAt).map(toHarEntry);
    const har = { log: { version: '1.2', creator: { name: 'opencode-browser-connector', version: '0.1.0' }, entries } };
    return { __saveText: JSON.stringify(har, null, 2), entries: entries.length };
  },

  async network_ws_frames(args) {
    const tabId = await resolveTab(args);
    const capture = captures.get(tabId);
    if (!capture) return { frames: [] };
    const frames = capture.wsFrames.filter((frame) => !args.socket || frame.socket === args.socket);
    const limit = args.limit ?? 100;
    const safe = frames.slice(-limit).map((frame) => (settings.redactSecrets && frame.data ? { ...frame, data: redactBody(frame.data) } : frame));
    return { total: frames.length, frames: safe };
  },

  async network_replay(args) {
    const tabId = await resolveTab(args);
    const entry = await resolveEntry(tabId, args.id);
    assertAllowedUrl(args.url ?? entry.url);
    const init = {
      method: args.method ?? entry.method,
      url: args.url ?? entry.url,
      headers: { ...Object.fromEntries(Object.entries(entry.requestHeaders ?? {}).filter(([name]) => !/^(:|host$|content-length$|cookie$|connection$|sec-|user-agent$|accept-encoding$|origin$|referer$)/i.test(name))), ...args.headers },
      body: args.body ?? entry.postData,
    };
    const script = `(async (init) => {
      const { url, ...options } = init;
      if (options.body == null || options.method === 'GET' || options.method === 'HEAD') delete options.body;
      const response = await fetch(url, { ...options, credentials: 'include' });
      const body = await response.text();
      return { status: response.status, headers: Object.fromEntries(response.headers), body };
    })(${JSON.stringify(init)})`;
    await ensureAttached(tabId);
    const { result, exceptionDetails } = await send(tabId, 'Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    const { status, headers, body } = result.value;
    const maxBody = args.maxBody ?? 20_000;
    const safeBody = settings.redactSecrets ? redactBody(body) : body;
    return { status, headers: settings.redactSecrets ? redactHeaders(headers) : headers, body: safeBody.slice(0, maxBody) };
  },

  async intercept(args) {
    switch (args.action) {
      case 'add': {
        if (!args.rule?.action) throw new Error('Falta rule.action');
        if (args.rule.modify?.url) assertAllowedUrl(args.rule.modify.url);
        const tabId = await resolveTab(args);
        const id = nextRuleId;
        nextRuleId += 1;
        const rule = { ...args.rule, id, hits: 0, tabId: args.rule.allTabs ? undefined : tabId };
        rules.set(id, rule);
        const targets = rule.allTabs ? await httpTabIds() : [tabId];
        for (const target of targets) {
          await ensureAttached(target);
          await syncFetchEverywhere(target);
        }
        return { id, attachedTabs: targets };
      }
      case 'remove':
        removeRule(args.id);
        return { removed: args.id, remaining: rules.size };
      case 'clear':
        rules.clear();
        for (const tabId of attachedTabs()) await syncFetchEverywhere(tabId).catch(() => {});
        return { cleared: true };
      default:
        return { rules: [...rules.values()] };
    }
  },

  async intercept_paused(args) {
    if (args.modify?.url) assertAllowedUrl(args.modify.url);
    if (args.action === 'list') {
      return {
        paused: [...paused.values()].map(({ id, tabId, event, rule, expiresAt }) => ({
          id,
          tabId,
          rule,
          url: settings.redactSecrets ? redactUrl(event.request.url) : event.request.url,
          method: event.request.method,
          stage: event.responseStatusCode != null ? 'response' : 'request',
          status: event.responseStatusCode,
          headers: settings.redactSecrets ? redactHeaders(event.request.headers) : event.request.headers,
          postData: settings.redactSecrets ? redactBody(pausedPostData(event.request)) : pausedPostData(event.request),
          expiresInMs: expiresAt - Date.now(),
        })),
      };
    }
    const item = paused.get(args.id);
    if (!item) throw new Error(`No hay request retenido con id ${args.id}`);
    clearTimeout(item.timer);
    paused.delete(item.id);
    const { tabId, sessionId, event } = item;
    const stage = event.responseStatusCode != null ? 'response' : 'request';
    switch (args.action) {
      case 'continue':
        if (stage === 'response') await modifyResponse(tabId, sessionId, event, args.modify ?? {});
        else await modifyRequest(tabId, sessionId, event, args.modify ?? {});
        break;
      case 'fulfill':
        await send(tabId, 'Fetch.fulfillRequest', fulfillParams(event.requestId, args), sessionId);
        break;
      case 'fail':
        await send(tabId, 'Fetch.failRequest', { requestId: event.requestId, errorReason: args.errorReason ?? 'BlockedByClient' }, sessionId);
        break;
      default:
        throw new Error(`Acción desconocida: ${args.action}`);
    }
    return { resolved: item.id, action: args.action };
  },

  async network_conditions(args) {
    const tabId = await resolveTab(args);
    await ensureAttached(tabId);
    const applied = [];
    if (args.offline != null || args.latencyMs != null || args.downloadKbps != null || args.uploadKbps != null) {
      await send(tabId, 'Network.emulateNetworkConditions', {
        offline: Boolean(args.offline),
        latency: args.latencyMs ?? 0,
        downloadThroughput: args.downloadKbps != null ? (args.downloadKbps * 1024) / 8 : -1,
        uploadThroughput: args.uploadKbps != null ? (args.uploadKbps * 1024) / 8 : -1,
      });
      applied.push('throttle');
    }
    if (args.disableCache != null) {
      await send(tabId, 'Network.setCacheDisabled', { cacheDisabled: args.disableCache });
      applied.push('cache');
    }
    if (args.extraHeaders) {
      await send(tabId, 'Network.setExtraHTTPHeaders', { headers: args.extraHeaders });
      applied.push('headers');
    }
    if (args.blockUrls) {
      await send(tabId, 'Network.setBlockedURLs', { urls: args.blockUrls });
      applied.push('blockUrls');
    }
    if (args.bypassCsp != null) {
      await send(tabId, 'Page.setBypassCSP', { enabled: args.bypassCsp });
      applied.push('bypassCsp');
    }
    holdTab(tabId, 'conditions');
    return { tabId, applied };
  },
};

async function httpTabIds() {
  const allTabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  return allTabs.filter((tab) => !isBlockedUrl(tab.url, settings.blockedDomains)).map((tab) => tab.id);
}
