import { join } from 'node:path';
import { ensurePairing } from './pairing.mjs';

const { extensionId, port, root } = ensurePairing();
const serverPath = join(root, 'bridge', 'server.mjs').replaceAll('\\', '/');

console.log(`Emparejamiento listo.
  ID de extensión: ${extensionId}
  Puerto local:    ${port}

1. Abre chrome://extensions y activa "Modo de desarrollador".
2. Pulsa "Cargar descomprimida" y elige: ${join(root, 'extension')}
3. Agrega esto dentro de "mcp" en ~/.config/opencode/opencode.jsonc:

    "browser": {
      "type": "local",
      "command": ["node", "${serverPath}"],
      "enabled": true,
      "timeout": 70000
    }
`);
