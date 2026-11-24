import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import { Link } from '../../bridge/link.mjs';

const token = 'a'.repeat(64);
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const origin = `chrome-extension://${extensionId}`;
let nextPort = 47950;

function connect(port, path, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.once('open', () => resolve({ ws, opened: true }));
    ws.once('error', () => resolve({ ws, opened: false }));
  });
}

function closeCode(ws) {
  return new Promise((resolve) => ws.once('close', resolve));
}

function fakeExtension(ws) {
  ws.send(JSON.stringify({ type: 'hello', token }));
  ws.on('message', (raw) => {
    const { id, method } = JSON.parse(raw);
    ws.send(JSON.stringify({ type: 'res', id, result: { echoed: method } }));
  });
}

async function startHub() {
  const port = nextPort;
  nextPort += 1;
  const link = new Link({ port, token, extensionId });
  await link.start();
  return { port, link };
}

test('rejects websites, wrong origin and wrong token', async () => {
  const { port, link } = await startHub();
  assert.equal((await connect(port, '/ext', { Origin: 'https://evil.example' })).opened, false);
  assert.equal((await connect(port, '/peer', { Origin: 'https://evil.example' })).opened, false);
  assert.equal((await connect(port, '/ext')).opened, false);
  const { ws } = await connect(port, '/ext', { Origin: origin });
  ws.send(JSON.stringify({ type: 'hello', token: 'b'.repeat(64) }));
  assert.equal(await closeCode(ws), 4401);
  assert.equal(link.extension, null);
  link.close();
});

test('rejects DNS rebinding through the Host header', async () => {
  const { port, link } = await startHub();
  const { opened } = await connect(port, '/ext', { Origin: origin, Host: `evil.example:${port}` });
  assert.equal(opened, false);
  link.close();
});

test('forwards calls from a peer and promotes the peer when the hub exits', async () => {
  const { port, link: hub } = await startHub();
  const peer = new Link({ port, token, extensionId });
  await peer.start();
  assert.equal(hub.role, 'hub');
  assert.equal(peer.role, 'peer');

  const { ws } = await connect(port, '/ext', { Origin: origin });
  fakeExtension(ws);
  assert.deepEqual(await peer.call('snapshot', {}, 2000), { echoed: 'snapshot' });

  hub.close();
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(peer.role, 'hub');
  const { ws: again } = await connect(port, '/ext', { Origin: origin });
  fakeExtension(again);
  assert.deepEqual(await peer.call('click', {}, 2000), { echoed: 'click' });
  peer.close();
  again.terminate();
});
