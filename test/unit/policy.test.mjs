import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyReplacements,
  base64ToUtf8,
  globToRegExp,
  isBlockedUrl,
  isProtectedUrl,
  matchRule,
  mergeHeaders,
  parseKeyCombo,
  redactBody,
  redactDeep,
  redactHeaders,
  redactUrl,
  utf8ToBase64,
} from '../../extension/lib/policy.js';

test('blocked domains cover subdomains but not lookalikes', () => {
  const blocked = ['viabcp.com'];
  assert.equal(isBlockedUrl('https://viabcp.com/', blocked), true);
  assert.equal(isBlockedUrl('https://bcpzonasegura.viabcp.com/x', blocked), true);
  assert.equal(isBlockedUrl('https://notviabcp.com/', blocked), false);
  assert.equal(isBlockedUrl('https://viabcp.com.evil.io/', blocked), false);
  assert.equal(isBlockedUrl('chrome://settings', blocked), false);
});

test('redaction hides secrets and keeps ordinary data', () => {
  const headers = redactHeaders({ Authorization: 'Bearer x', 'content-type': 'json', Cookie: 'a=1' });
  assert.deepEqual(headers, { Authorization: '[redacted]', 'content-type': 'json', Cookie: '[redacted]' });
  const json = redactBody('{"email":"a@b.c","password":"hunter2","accessToken":"abc"}');
  assert.equal(json, '{"email":"a@b.c","password":"[redacted]","accessToken":"[redacted]"}');
  assert.equal(redactBody('user=ana&pwd=123&x=1'), 'user=ana&pwd=[redacted]&x=1');
  assert.equal(redactUrl('https://a.io/p?token=abc&page=2'), 'https://a.io/p?token=[redacted]&page=2');
});

test('redactDeep covers raw CDP payload shapes', () => {
  const out = redactDeep({
    cookies: [{ name: 'sid', value: 'x', domain: 'a.io' }],
    params: {
      request: { url: 'https://a.io/?token=abc', headers: { Cookie: 'a=1', Accept: '*/*' }, postData: 'pwd=1', postDataEntries: [{ bytes: 'eA==' }] },
      responseHeaders: [{ name: 'Set-Cookie', value: 'b=2' }, { name: 'Server', value: 'nginx' }],
    },
    headersText: 'HTTP/1.1 200 OK\r\nSet-Cookie: sid=x',
    associatedCookies: [{ cookie: { value: 'x' } }],
    plain: 'visible',
  });
  assert.equal(out.headersText, '[redacted]');
  assert.equal(out.associatedCookies, '[redacted]');
  assert.equal(out.cookies[0].value, '[redacted]');
  assert.equal(out.cookies[0].domain, 'a.io');
  assert.equal(out.params.request.url, 'https://a.io/?token=[redacted]');
  assert.deepEqual(out.params.request.headers, { Cookie: '[redacted]', Accept: '*/*' });
  assert.equal(out.params.request.postData, 'pwd=[redacted]');
  assert.equal(out.params.request.postDataEntries, '[redacted]');
  assert.deepEqual(out.params.responseHeaders, [{ name: 'Set-Cookie', value: '[redacted]' }, { name: 'Server', value: 'nginx' }]);
  assert.equal(out.plain, 'visible');
});

test('browser and extension pages are protected, the new tab page is not', () => {
  assert.equal(isProtectedUrl('chrome-extension://abc/popup.html'), true);
  assert.equal(isProtectedUrl('chrome://settings'), true);
  assert.equal(isProtectedUrl(' CHROME://extensions'), true);
  assert.equal(isProtectedUrl('chrome://newtab/'), false);
  assert.equal(isProtectedUrl('https://example.com/chrome://x'), false);
});

test('rules match by glob, regex, method, stage and type', () => {
  const request = { tabId: 1, stage: 'request', url: 'https://api.x.io/v1/users', method: 'GET', resourceType: 'XHR' };
  assert.equal(matchRule({ url: '*api.x.io/*' }, request), true);
  assert.equal(matchRule({ url: '*api.y.io/*' }, request), false);
  assert.equal(matchRule({ regex: 'v\\d/users$' }, request), true);
  assert.equal(matchRule({ url: '*', method: 'POST' }, request), false);
  assert.equal(matchRule({ url: '*', stage: 'response' }, request), false);
  assert.equal(matchRule({ url: '*', resourceTypes: ['Script'] }, request), false);
  assert.equal(matchRule({ url: '*', tabId: 2 }, request), false);
});

test('glob escapes regex characters', () => {
  assert.equal(globToRegExp('https://a.io/x').test('https://aXio/x'), false);
  assert.equal(globToRegExp('*.js').test('https://a.io/app.js'), true);
});

test('body replacement handles literal and regex', () => {
  assert.equal(applyReplacements('a.b a.b', [{ find: 'a.b', replace: 'c' }]), 'c c');
  assert.equal(applyReplacements('x1 x22', [{ find: 'x\\d+', replace: 'y', regex: true }]), 'y y');
});

test('headers merge case-insensitively and support removal', () => {
  const merged = mergeHeaders(
    [{ name: 'Content-Type', value: 'a' }, { name: 'X-Old', value: '1' }, { name: 'Keep', value: '2' }],
    { 'content-type': 'b', 'X-New': '3' },
    ['x-old'],
  );
  assert.deepEqual(merged, [{ name: 'Keep', value: '2' }, { name: 'content-type', value: 'b' }, { name: 'X-New', value: '3' }]);
});

test('base64 round trips unicode', () => {
  assert.equal(base64ToUtf8(utf8ToBase64('señal ñandú 日本')), 'señal ñandú 日本');
});

test('key combos parse modifiers and editing commands', () => {
  const selectAll = parseKeyCombo('Control+A');
  assert.equal(selectAll.modifiers, 2);
  assert.deepEqual(selectAll.commands, ['selectAll']);
  assert.equal(selectAll.text, undefined);
  assert.equal(parseKeyCombo('Enter').vk, 13);
  assert.equal(parseKeyCombo('Shift+Tab').modifiers, 8);
  assert.equal(parseKeyCombo('F5').vk, 116);
  assert.throws(() => parseKeyCombo('Hyper+x'));
});
