import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

const HELLO_TIMEOUT_MS = 5000;
const EXTENSION_WAIT_MS = 35_000;
const REELECT_MIN_MS = 100;
const REELECT_JITTER_MS = 400;
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function sameToken(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function log(message) {
  process.stderr.write(`[opencode-browser] ${message}\n`);
}

// One process owns the port (hub). Other OpenCode instances join it as peers,
// and a peer takes over the port when the hub process exits.
export class Link {
  constructor({ port, token, extensionId }) {
    this.port = port;
    this.token = token;
    this.origin = `chrome-extension://${extensionId}`;
    this.role = 'starting';
    this.extension = null;
    this.hubSocket = null;
    this.pending = new Map();
    this.waiters = new Set();
    this.nextId = 1;
    this.closed = false;
  }

  async start() {
    try {
      await this.#listen();
      this.role = 'hub';
      log(`hub en 127.0.0.1:${this.port}`);
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      await this.#joinHub();
    }
  }

  #listen() {
    return new Promise((resolve, reject) => {
      const server = createServer((_request, response) => {
        response.writeHead(404).end();
      });
      const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
      this.sockets = sockets;
      server.on('upgrade', (request, socket, head) => {
        if (!this.#acceptUpgrade(request)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        sockets.handleUpgrade(request, socket, head, (ws) => this.#onClient(ws, request.url));
      });
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  #acceptUpgrade(request) {
    if (!LOOPBACK_ADDRESSES.has(request.socket.remoteAddress)) return false;
    if (request.headers.host !== `127.0.0.1:${this.port}`) return false;
    if (request.url === '/ext') return request.headers.origin === this.origin;
    return request.url === '/peer' && request.headers.origin === undefined;
  }

  #onClient(ws, path) {
    const helloTimer = setTimeout(() => ws.close(4401, 'hello timeout'), HELLO_TIMEOUT_MS);
    ws.once('message', (raw) => {
      clearTimeout(helloTimer);
      let hello;
      try {
        hello = JSON.parse(raw);
      } catch {
        ws.close(4400, 'bad hello');
        return;
      }
      if (hello.type !== 'hello' || !sameToken(hello.token, this.token)) {
        ws.close(4401, 'bad token');
        return;
      }
      if (path === '/ext') this.#setExtension(ws);
      else this.#servePeer(ws);
    });
    ws.on('error', () => {});
  }

  #setExtension(ws) {
    this.extension?.close(4000, 'replaced');
    this.extension = ws;
    log('extensión conectada');
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
    ws.on('message', (raw) => this.#onResponse(raw));
    ws.on('close', () => {
      if (this.extension !== ws) return;
      this.extension = null;
      this.#failPending('La extensión se desconectó durante la operación');
      log('extensión desconectada');
    });
  }

  #servePeer(ws) {
    ws.on('message', async (raw) => {
      const { id, method, params, timeoutMs } = JSON.parse(raw);
      try {
        const result = await this.call(method, params, timeoutMs);
        ws.send(JSON.stringify({ type: 'res', id, result }));
      } catch (error) {
        ws.send(JSON.stringify({ type: 'res', id, error: error.message }));
      }
    });
  }

  #joinHub() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/peer`, { maxPayload: MAX_PAYLOAD_BYTES });
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'hello', token: this.token }));
        this.hubSocket = ws;
        this.role = 'peer';
        log('unido a hub existente');
        resolve();
      });
      ws.on('message', (raw) => this.#onResponse(raw));
      ws.once('error', (error) => {
        if (this.role !== 'peer') reject(error);
      });
      ws.once('close', () => {
        this.hubSocket = null;
        this.#failPending('El hub se cerró durante la operación');
        if (!this.closed) this.#reelect();
      });
    });
  }

  #reelect() {
    this.role = 'starting';
    const delay = REELECT_MIN_MS + Math.random() * REELECT_JITTER_MS;
    setTimeout(() => {
      this.start().catch((error) => {
        log(`reelección falló: ${error.message}`);
        if (!this.closed) this.#reelect();
      });
    }, delay);
  }

  #onResponse(raw) {
    const message = JSON.parse(raw);
    if (message.type !== 'res') return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
  }

  #failPending(reason) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  async #waitForExtension() {
    if (this.extension) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        reject(new Error('La extensión no está conectada. Abre Chrome y revisa que OpenCode Browser Connector esté activa (badge ON).'));
      }, EXTENSION_WAIT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.add(done);
    });
  }

  async call(method, params = {}, timeoutMs = 60_000) {
    if (this.role === 'starting') await this.start();
    if (this.role === 'hub') await this.#waitForExtension();
    const channel = this.role === 'hub' ? this.extension : this.hubSocket;
    if (!channel) throw new Error('Sin conexión con el hub');
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout de ${timeoutMs} ms esperando ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      channel.send(JSON.stringify({ type: 'req', id, method, params, timeoutMs }));
    });
  }

  close() {
    this.closed = true;
    this.hubSocket?.close();
    for (const client of this.sockets?.clients ?? []) client.terminate();
    this.server?.close();
  }
}
