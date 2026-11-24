import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(ROOT, 'extension', 'manifest.json');
const PAIRING_PATH = join(ROOT, 'extension', 'pairing.json');
const DEFAULT_PORT = 47823;

function extensionIdFromKey(publicKeyBase64) {
  const digest = createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex');
  return [...digest.slice(0, 32)].map((char) => String.fromCharCode(97 + parseInt(char, 16))).join('');
}

function ensureManifestKey() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  if (manifest.key) return manifest.key;
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  manifest.key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.key;
}

export function ensurePairing() {
  const key = ensureManifestKey();
  const extensionId = extensionIdFromKey(key);
  let pairing;
  if (existsSync(PAIRING_PATH)) {
    pairing = JSON.parse(readFileSync(PAIRING_PATH, 'utf8'));
  } else {
    pairing = { port: Number(process.env.OPENCODE_BROWSER_PORT) || DEFAULT_PORT, token: randomBytes(32).toString('hex') };
    writeFileSync(PAIRING_PATH, `${JSON.stringify(pairing, null, 2)}\n`, { mode: 0o600 });
  }
  return { ...pairing, extensionId, root: ROOT };
}
