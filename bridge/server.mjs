#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Link } from './link.mjs';
import { ensurePairing } from './pairing.mjs';
import { INSTRUCTIONS, TOOLS } from './tools.mjs';

const MAX_TEXT_CHARS = 60_000;
const TIMEOUT_MARGIN_MS = 5000;

const pairing = ensurePairing();
const link = new Link(pairing);

function saveFile(path, data) {
  const fullPath = resolve(path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, data);
  return fullPath;
}

function textBlock(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const clipped = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[recortado: ${text.length} chars]` : text;
  return { type: 'text', text: clipped };
}

function toContent(args, result) {
  const { __image: image, __saveText: saveText, __saveBase64: saveBase64, mimeType, ...rest } = result;
  if (image) {
    const savedTo = args.savePath ? saveFile(args.savePath, Buffer.from(image, 'base64')) : undefined;
    return [{ type: 'image', data: image, mimeType }, textBlock({ ...rest, savedTo })];
  }
  if (saveText != null) return [textBlock({ ...rest, savedTo: saveFile(args.savePath, saveText) })];
  if (saveBase64 != null) return [textBlock({ ...rest, savedTo: saveFile(args.savePath, Buffer.from(saveBase64, 'base64')) })];
  return [textBlock(rest)];
}

function timeoutFor(args) {
  return (args.timeoutMs ?? 55_000) + TIMEOUT_MARGIN_MS;
}

async function runBatch({ steps, continueOnError }) {
  const content = [];
  for (const [index, step] of steps.entries()) {
    const args = step.args ?? {};
    try {
      if (step.tool === 'batch') throw new Error('batch no se puede anidar');
      const result = await link.call(step.tool, args, timeoutFor(args));
      content.push({ type: 'text', text: `[${index}] ${step.tool}: ok` }, ...toContent(args, result));
    } catch (error) {
      content.push({ type: 'text', text: `[${index}] ${step.tool}: ERROR ${error.message}` });
      if (!continueOnError) return { content, isError: true };
    }
  }
  return { content };
}

async function runTool(name, args) {
  if (name === 'batch') return runBatch(args);
  const result = await link.call(name, args, timeoutFor(args));
  const payload = name === 'status' ? { ...result, bridge: link.role } : result;
  return { content: toContent(args, payload) };
}

const server = new Server(
  { name: 'opencode-browser', version: '0.1.0' },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    return await runTool(params.name, params.arguments ?? {});
  } catch (error) {
    return { content: [{ type: 'text', text: error.message }], isError: true };
  }
});

await link.start();
await server.connect(new StdioServerTransport());

const shutdown = () => {
  link.close();
  process.exit(0);
};
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
