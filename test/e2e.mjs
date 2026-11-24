// End-to-end test: real Chromium + real extension + real MCP server over stdio.
// Usage: CHROMIUM_PATH=<chrome.exe> node test/e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket, { WebSocketServer } from 'ws';
import { ensurePairing } from '../bridge/pairing.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROMIUM = process.env.CHROMIUM_PATH;
const SERVER_PORT = 47901;
const CROSS_PORT = 47902;
const DEVTOOLS_PORT = 47904;
const HEADED = process.env.HEADED === '1';
const EXTENSION_ID = ensurePairing().extensionId;

if (!CHROMIUM || !existsSync(CHROMIUM)) {
  console.error('Define CHROMIUM_PATH con un Chromium o Chrome for Testing (Chrome de marca ignora --load-extension).');
  process.exit(2);
}

const home = (port) => `http://127.0.0.1:${port}`;
const PAGE = `<!doctype html><html><head><title>Banco de pruebas</title></head><body>
<h1>Banco de pruebas</h1>
<button id="go" onclick="document.getElementById('out').textContent='clicked:'+event.isTrusted">Pulsar</button>
<input id="name" aria-label="Nombre" />
<select id="sel" aria-label="Plan"><option value="a">Alfa</option><option value="b">Beta</option></select>
<div id="out">idle</div><div id="api">pending</div><div id="mock">pending</div><div id="mod">pending</div>
<div id="held">pending</div><div id="ws">pending</div>
<iframe id="cross" src="http://localhost:${CROSS_PORT}/frame" title="cruzado"></iframe>
<script>
window.load = async (id, url, init) => {
  try {
    const response = await fetch(url, init);
    document.getElementById(id).textContent = response.status + ':' + await response.text();
  } catch (error) { document.getElementById(id).textContent = 'failed:' + error.message; }
};
console.log('hola-consola');
load('api', '/api/data?token=supersecreto');
</script></body></html>`;

const FRAME = `<!doctype html><html><body><button id="inner" onclick="this.textContent='iframe-ok'">Dentro</button>
<script>fetch('/frame-api').then(r=>r.text()).then(t=>{document.body.dataset.api=t;});</script></body></html>`;

function appServer(request, response) {
  const url = new URL(request.url, 'http://x');
  const reply = (type, body, status = 200, headers = {}) => {
    response.writeHead(status, { 'content-type': type, ...headers });
    response.end(body);
  };
  if (url.pathname === '/') return reply('text/html', PAGE, 200, { 'set-cookie': 'sid=topsecret; HttpOnly; Path=/' });
  if (url.pathname === '/api/data') return reply('application/json', '{"value":"real","accessToken":"abc123"}');
  if (url.pathname === '/echo') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => reply('text/plain', `${request.method}|${request.headers['x-added'] ?? '-'}|${Buffer.concat(chunks)}`));
    return undefined;
  }
  if (url.pathname === '/frame') return reply('text/html', FRAME);
  if (url.pathname === '/frame-api') return reply('text/plain', 'frame-real');
  return reply('text/plain', 'nope', 404);
}

const httpServer = createServer(appServer).listen(SERVER_PORT, '127.0.0.1');
const crossServer = createServer(appServer).listen(CROSS_PORT, '127.0.0.1');
const wsServer = new WebSocketServer({ port: 47903, host: '127.0.0.1' });
wsServer.on('connection', (socket) => socket.on('message', (data) => socket.send(`echo:${data}`)));

const profile = mkdtempSync(join(tmpdir(), 'opencode-browser-e2e-'));
const chromeArgs = [
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${join(ROOT, 'extension')}`,
  `--load-extension=${join(ROOT, 'extension')}`,
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${DEVTOOLS_PORT}`,
  '--remote-allow-origins=*',
  '--site-per-process',
  ...(HEADED ? [] : ['--headless=new']),
  'about:blank',
];

const results = [];
let client;
let chrome;

async function call(name, args = {}) {
  const output = await client.callTool({ name, arguments: args }, undefined, { timeout: 70_000 });
  const text = output.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  if (output.isError) throw new Error(`${name}: ${text}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { json, text, content: output.content };
}

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

const value = async (expression) => (await call('evaluate', { expression })).json.value;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chromeClose = (tabId) => fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`)
  .then((response) => response.json())
  .then((targets) => Promise.all(targets.filter((target) => target.type === 'page' && target.url.includes(EXTENSION_ID)).map((target) => fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/close/${target.id}`))))
  .then(() => tabId);

// Plays the user's role: DevTools reaches the popup directly, outside the connector.
async function openDevtoolsPage(url) {
  const response = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const target = await response.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.once('open', resolve));
  const pending = new Map();
  let nextId = 1;
  socket.on('message', (raw) => {
    const message = JSON.parse(raw);
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
  });
  return {
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

async function waitConnected() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await call('status');
    } catch {
      await delay(500);
    }
  }
  throw new Error('La extensión nunca se conectó');
}

async function run() {
  chrome = spawn(CHROMIUM, chromeArgs, { stdio: 'ignore' });
  client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'bridge', 'server.mjs')], stderr: 'inherit' }));

  await check('MCP expone herramientas', async () => {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 30, `solo ${tools.length} herramientas`);
    assert.ok(tools.some((tool) => tool.name === 'intercept'));
  });

  await check('extensión conecta al bridge', async () => {
    const { text } = await waitConnected();
    assert.match(text, /"enabled": true/);
    assert.match(text, /"bridge": "hub"/);
  });

  await check('crea pestaña y navega', async () => {
    await call('tabs', { action: 'new' });
    await call('network_capture', { action: 'start', captureBodies: true });
    const { json } = await call('navigate', { url: `${home(SERVER_PORT)}/` });
    assert.equal(json.title, 'Banco de pruebas');
    await call('wait_for', { networkIdle: true });
  });

  await check('snapshot entrega refs utilizables', async () => {
    const { json } = await call('snapshot', {});
    assert.match(json.snapshot, /button "Pulsar"/);
    const ref = /button "Pulsar" \[ref=(\w+)\]/.exec(json.snapshot)[1];
    await call('click', { ref });
    assert.equal(await value("document.getElementById('out').textContent"), 'clicked:true');
  });

  await check('type y select_option', async () => {
    await call('type', { selector: '#name', text: 'Gabriel señal' });
    assert.equal(await value("document.getElementById('name').value"), 'Gabriel señal');
    await call('press_key', { keys: 'Control+A' });
    await call('press_key', { keys: 'Backspace' });
    assert.equal(await value("document.getElementById('name').value"), '');
    await call('select_option', { selector: '#sel', value: 'Beta' });
    assert.equal(await value("document.getElementById('sel').value"), 'b');
  });

  await check('selector text= encuentra por texto', async () => {
    await call('click', { selector: 'text=Pulsar' });
  });

  await check('screenshot devuelve imagen y guarda archivo', async () => {
    const path = join(profile, 'shot.jpg');
    const { content } = await call('screenshot', { savePath: path });
    assert.ok(content.some((part) => part.type === 'image'));
    assert.ok(statSync(path).size > 1000);
    const full = await call('screenshot', { fullPage: true, format: 'png' });
    assert.ok(full.content[0].data.length > 1000);
  });

  await check('console_logs captura consola', async () => {
    await call('tabs', { action: 'reload' });
    await call('wait_for', { networkIdle: true });
    const { json } = await call('console_logs', {});
    assert.ok(json.entries.some((entry) => entry.text === 'hola-consola'), JSON.stringify(json));
  });

  await check('captura red y oculta secretos', async () => {
    const { json } = await call('network_list', { url: '/api/data' });
    assert.ok(json.total >= 1);
    const [item] = json.requests;
    assert.match(item.url, /token=\[redacted\]/);
    const detail = await call('network_get', { id: item.id });
    assert.match(detail.json.body, /"value":"real"/);
    assert.match(detail.json.body, /"accessToken":"\[redacted\]"/);
    const root = await call('network_list', { type: 'Document' });
    const document = root.json.requests.findLast((request) => request.url === `${home(SERVER_PORT)}/`);
    const page = await call('network_get', { id: document.id, includeBody: false });
    assert.equal(page.json.responseHeaders['set-cookie'] ?? page.json.responseHeaders['Set-Cookie'], '[redacted]');
  });

  await check('evaluate espera promesas, await y const repetido', async () => {
    assert.equal(await value('new Promise((resolve) => setTimeout(() => resolve(7), 50))'), 7);
    assert.equal(await value('await Promise.resolve(8)'), 8);
    await value('const repetido = 1; repetido');
    assert.equal(await value('const repetido = 2; repetido'), 2);
    await assert.rejects(value("JSON.parse('{')"), /SyntaxError/);
  });

  await check('cookies HttpOnly listadas sin valor', async () => {
    const { json } = await call('cookies', { action: 'list', url: `${home(SERVER_PORT)}/` });
    const sid = json.cookies.find((cookie) => cookie.name === 'sid');
    assert.ok(sid.httpOnly);
    assert.doesNotMatch(sid.value, /topsecret/);
  });

  await check('intercept mock con fulfill', async () => {
    await call('intercept', { action: 'add', rule: { url: '*/api/mock', action: 'fulfill', status: 201, headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }, body: 'simulado ñ' } });
    await value("load('mock','/api/mock')");
    assert.equal(await value("document.getElementById('mock').textContent"), '201:simulado ñ');
  });

  await check('intercept modifica request', async () => {
    await call('intercept', { action: 'add', rule: { url: '*/echo', action: 'modify', method: 'POST', modify: { setHeaders: { 'x-added': 'si' }, replaceBody: [{ find: 'antes', replace: 'despues' }] } } });
    await value("load('mod','/echo',{method:'POST',body:'antes'})");
    assert.equal(await value("document.getElementById('mod').textContent"), '200:POST|si|despues');
  });

  await check('intercept reescribe response', async () => {
    await call('intercept', { action: 'add', rule: { url: '*/api/data*', stage: 'response', action: 'modify', modify: { status: 299, setHeaders: { 'x-tag': '1' }, replaceBody: [{ find: 'real', replace: 'falso' }] } } });
    await value("load('api','/api/data')");
    assert.match(await value("document.getElementById('api').textContent"), /^299:.*falso/);
  });

  await check('intercept bloquea', async () => {
    await call('intercept', { action: 'add', rule: { url: '*/api/blocked', action: 'block' } });
    await value("load('mock','/api/blocked')");
    assert.match(await value("document.getElementById('mock').textContent"), /^failed:/);
  });

  await check('hold retiene y se resuelve a mano', async () => {
    await call('intercept', { action: 'add', rule: { url: '*/api/held', action: 'hold', holdMs: 20000 } });
    await call('evaluate', { expression: "void load('held','/api/held')" });
    await delay(300);
    const { json } = await call('intercept_paused', { action: 'list' });
    assert.equal(json.paused.length, 1);
    assert.equal(await value("document.getElementById('held').textContent"), 'pending');
    await call('intercept_paused', { action: 'fulfill', id: json.paused[0].id, status: 200, headers: { 'content-type': 'text/plain' }, body: 'liberado' });
    await call('wait_for', { text: 'liberado', timeoutMs: 3000 });
  });

  await check('reglas retiradas dejan pasar tráfico', async () => {
    await call('intercept', { action: 'clear' });
    await value("load('api','/api/data')");
    assert.match(await value("document.getElementById('api').textContent"), /^200:.*real/);
  });

  await check('network_replay repite con cambios', async () => {
    const { json } = await call('network_list', { url: '/echo' });
    const { json: replay } = await call('network_replay', { id: json.requests.at(-1).id, body: 'replay' });
    assert.equal(replay.status, 200);
    assert.match(replay.body, /POST\|si\|replay/);
  });

  await check('captura frames WebSocket', async () => {
    await value(`new Promise((resolve) => { const s = new WebSocket('ws://127.0.0.1:47903'); s.onopen = () => s.send('ping-ws'); s.onmessage = (e) => { document.getElementById('ws').textContent = e.data; s.close(); resolve(); }; })`);
    await delay(200);
    const { json } = await call('network_ws_frames', {});
    assert.ok(json.frames.some((frame) => frame.event === 'sent' && frame.data === 'ping-ws'));
    assert.ok(json.frames.some((frame) => frame.event === 'received' && frame.data === 'echo:ping-ws'));
  });

  await check('iframe cruzado: snapshot, click e intercept', async () => {
    await call('intercept', { action: 'add', rule: { url: '*/frame-api', action: 'fulfill', headers: { 'content-type': 'text/plain' }, body: 'frame-mock' } });
    await call('tabs', { action: 'reload' });
    await call('wait_for', { networkIdle: true });
    await delay(500);
    const { json } = await call('snapshot', {});
    const match = /button "Dentro" \[ref=(s\d+e\d+)\]/.exec(json.snapshot);
    assert.ok(match, json.snapshot);
    await call('click', { ref: match[1] });
    await delay(200);
    const { json: state } = await call('status');
    assert.ok(state.attachedTabs.length >= 1);
    const after = await call('snapshot', {});
    assert.match(after.json.snapshot, /button "iframe-ok"/);
    await call('intercept', { action: 'clear' });
  });

  await check('network_conditions offline', async () => {
    await call('network_conditions', { offline: true });
    await value("load('api','/api/data')");
    assert.match(await value("document.getElementById('api').textContent"), /^failed:/);
    await call('network_conditions', { offline: false });
  });

  await check('emulate viewport y tema', async () => {
    await call('emulate', { viewport: { width: 390, height: 800 }, colorScheme: 'dark', timezone: 'Asia/Tokyo' });
    assert.equal(await value('innerWidth'), 390);
    assert.equal(await value("matchMedia('(prefers-color-scheme: dark)').matches"), true);
    assert.equal(await value('Intl.DateTimeFormat().resolvedOptions().timeZone'), 'Asia/Tokyo');
    await call('emulate', { reset: true });
  });

  await check('storage local', async () => {
    await call('storage', { action: 'set', key: 'k', value: 'v' });
    assert.equal((await call('storage', { action: 'get', key: 'k' })).json.value, 'v');
  });

  await check('diálogos con herramienta dialog', async () => {
    await call('evaluate', { expression: "setTimeout(() => { window.answer = confirm('seguro?'); }, 50); 1" });
    await delay(300);
    const { json } = await call('dialog', { action: 'status' });
    assert.equal(json.dialog.message, 'seguro?');
    await call('dialog', { action: 'accept' });
    assert.equal(await value('window.answer'), true);
  });

  await check('inject_script corre antes de la página', async () => {
    const { json } = await call('inject_script', { action: 'add', source: 'window.__hook = 42;' });
    await call('tabs', { action: 'reload' });
    assert.equal(await value('window.__hook'), 42);
    await call('inject_script', { action: 'remove', id: json.id });
  });

  await check('HAR y PDF se guardan', async () => {
    const harPath = join(profile, 'trafico.har');
    await call('network_export_har', { savePath: harPath });
    const har = JSON.parse(readFileSync(harPath, 'utf8'));
    assert.ok(har.log.entries.length > 3);
    assert.doesNotMatch(JSON.stringify(har), /topsecret|abc123/);
    const pdfPath = join(profile, 'pagina.pdf');
    await call('pdf', { savePath: pdfPath });
    assert.equal(readFileSync(pdfPath).subarray(0, 4).toString(), '%PDF');
  });

  await check('CDP crudo', async () => {
    const { json } = await call('cdp', { method: 'Performance.enable' });
    assert.deepEqual(json, {});
    const { json: metrics } = await call('cdp', { method: 'Performance.getMetrics' });
    assert.ok(metrics.metrics.length > 5);
  });

  await check('global_rules bloquea sin debugger', async () => {
    const { json } = await call('global_rules', { action: 'add', rule: { action: 'block', urlFilter: '||127.0.0.1:47901/api/global' } });
    await value("load('mock','/api/global')");
    assert.match(await value("document.getElementById('mock').textContent"), /^failed:/);
    await call('global_rules', { action: 'remove', id: json.id });
  });

  await check('batch encadena pasos', async () => {
    const { text } = await call('batch', { steps: [
      { tool: 'evaluate', args: { expression: '1+1' } },
      { tool: 'read_page', args: { selector: 'h1' } },
    ] });
    assert.match(text, /\[1\] read_page: ok/);
    assert.match(text, /Banco de pruebas/);
  });

  await check('dominios bloqueados rechazan navegación', async () => {
    await assert.rejects(call('navigate', { url: 'https://www.viabcp.com/' }), /bloqueado/);
  });

  await check('agente no alcanza el popup ni esquiva bloqueos', async () => {
    const popup = `chrome-extension://${EXTENSION_ID}/popup.html`;
    await assert.rejects(call('navigate', { url: popup }), /protegid/);
    await assert.rejects(call('tabs', { action: 'new', url: popup }), /protegid/);
    await assert.rejects(call('windows', { action: 'new', url: popup }), /protegid/);
    await assert.rejects(call('windows', { action: 'new', url: 'https://www.viabcp.com/' }), /bloqueado/);
    await assert.rejects(call('browser_data', { kind: 'download', url: 'https://www.viabcp.com/x' }), /bloqueado/);
    const { json } = await call('network_list', { url: '/echo' });
    await assert.rejects(call('network_replay', { id: json.requests.at(-1).id, url: 'https://www.viabcp.com/' }), /bloqueado/);
    await assert.rejects(call('intercept', { action: 'add', rule: { url: '*', action: 'modify', modify: { url: 'https://www.viabcp.com/' } } }), /bloqueado/);
  });

  await check('CDP crudo tampoco alcanza el popup', async () => {
    const { json: created } = await call('tabs', { action: 'new', url: `${home(SERVER_PORT)}/` });
    await call('cdp', { method: 'Page.navigate', params: { url: `chrome-extension://${EXTENSION_ID}/popup.html` } }).catch(() => {});
    await delay(500);
    await assert.rejects(call('evaluate', { tabId: created.tabId, expression: '1' }), /protegid/);
    await chromeClose(created.tabId);
  });

  await check('browser_data lista extensiones y historial', async () => {
    const { json } = await call('browser_data', { kind: 'history', query: '127.0.0.1' });
    assert.ok(json.items.length >= 1);
  });

  await check('pestañas nuevas van al grupo OpenCode y se cierran', async () => {
    const { json } = await call('tabs', { action: 'list' });
    assert.ok(json.tabs.length >= 1);
    await call('tabs', { action: 'close' });
  });

  await check('navigate sin pestaña propia no pisa la del usuario', async () => {
    await call('tabs', { action: 'new' });
    await call('tabs', { action: 'new' });
    await call('tabs', { action: 'close' });
    const remaining = (await call('tabs', { action: 'list' })).json.tabs;
    const { json } = await call('navigate', { url: `${home(SERVER_PORT)}/` });
    assert.ok(!remaining.some((tab) => tab.tabId === json.tabId));
    const after = (await call('tabs', { action: 'list' })).json.tabs;
    assert.equal(after.length, remaining.length + 1);
    await call('tabs', { action: 'close' });
  });

  await check('cdp crudo y eventos respetan la redacción', async () => {
    await call('tabs', { action: 'new', url: `${home(SERVER_PORT)}/` });
    await call('wait_for', { networkIdle: true });
    await call('cdp_events', { action: 'subscribe', methods: ['Network.requestWillBeSent', 'Network.responseReceivedExtraInfo'] });
    await call('tabs', { action: 'reload' });
    await call('wait_for', { networkIdle: true });
    const events = await call('cdp_events', { action: 'read', limit: 500 });
    assert.ok(events.json.events.length > 1);
    assert.doesNotMatch(events.text, /topsecret|supersecreto/);
    const cookies = await call('cdp', { method: 'Network.getCookies' });
    assert.ok(cookies.json.cookies.length >= 1);
    assert.doesNotMatch(cookies.text, /topsecret/);
    await call('cdp_events', { action: 'clear' });
  });

  await check('clic y captura son rápidos en pestaña de fondo', async () => {
    const started = Date.now();
    await call('click', { selector: '#go' });
    await call('screenshot', {});
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  });

  await check('popup se ve bien y su interruptor corta al agente', async () => {
    const popup = await openDevtoolsPage(`chrome-extension://${EXTENSION_ID}/popup.html`);
    await delay(800);
    await popup.send('Emulation.setDeviceMetricsOverride', { width: 392, height: 640, deviceScaleFactor: 2, mobile: false });
    const shot = await popup.send('Page.captureScreenshot', { format: 'png' });
    if (process.env.SHOT_DIR) writeFileSync(join(process.env.SHOT_DIR, 'popup.png'), Buffer.from(shot.data, 'base64'));
    const text = await popup.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
    assert.match(text.result.value, /Conectado a OpenCode/);
    assert.match(text.result.value, /tabs/);
    await popup.send('Runtime.evaluate', { expression: "document.getElementById('enabled').click()" });
    await delay(400);
    await assert.rejects(call('tabs', { action: 'list' }), /pausado/);
    await popup.send('Runtime.evaluate', { expression: "document.getElementById('enabled').click()" });
    await delay(400);
    await call('tabs', { action: 'list' });
    popup.close();
  });
}

let exitCode = 0;
try {
  await run();
} catch (error) {
  console.error(error);
  exitCode = 1;
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} pasaron`);
if (failed.length) exitCode = 1;

await client?.close().catch(() => {});
chrome?.kill();
httpServer.close();
crossServer.close();
wsServer.close();
await delay(500);
rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
process.exit(exitCode);
