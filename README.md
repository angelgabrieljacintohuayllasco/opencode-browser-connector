# OpenCode Browser Connector

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)
![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![MCP](https://img.shields.io/badge/protocol-MCP-black)

> **EN:** MCP connector that lets OpenCode (or any MCP client: Claude Code, Codex...) drive your real Chrome with your logged-in sessions: tabs, DOM, screenshots, cookies, full network capture and live request/response interception. Chrome MV3 extension + local Node bridge. Docs below are in Spanish.

Conector MCP que da a OpenCode control de tu Chrome real, con tus sesiones iniciadas. Funciona como Claude in Chrome, pero para OpenCode. Al ser MCP estándar, también sirve para Claude Code, Codex o cualquier cliente MCP.

```
OpenCode ⇄ stdio MCP ⇄ bridge local 127.0.0.1:47823 ⇄ WebSocket ⇄ extensión MV3 ⇄ chrome.debugger (CDP)
```

## Instalación

Requisitos: Node.js 20+ y Chrome 125+.

```bash
git clone https://github.com/angelgabrieljacintohuayllasco/opencode-browser-connector.git
cd opencode-browser-connector
npm install
npm run setup
```

1. Abre `chrome://extensions` y activa **Modo de desarrollador**.
2. Pulsa **Cargar descomprimida** y elige la carpeta `extension/`.
3. Agrega el bloque que imprime `npm run setup` dentro de `"mcp"` en `~/.config/opencode/opencode.jsonc`.
4. Reinicia OpenCode. El icono de la extensión muestra `ON` cuando hay conexión.

`npm run setup` genera `extension/pairing.json` con el token privado. Está en `.gitignore` y no debe compartirse.

## Herramientas

| Área | Herramientas |
| --- | --- |
| Pestañas | `tabs`, `windows`, `navigate` |
| Lectura | `snapshot`, `read_page`, `screenshot`, `pdf`, `console_logs` |
| Acción | `click`, `type`, `press_key`, `mouse`, `select_option`, `upload_file`, `dialog`, `wait_for` |
| Código | `evaluate`, `inject_script` |
| Datos | `cookies`, `storage`, `browser_data` |
| Tráfico | `network_capture`, `network_list`, `network_get`, `network_replay`, `network_ws_frames`, `network_export_har` |
| Interceptación | `intercept`, `intercept_paused`, `network_conditions`, `global_rules` |
| Entorno | `emulate` |
| Bajo nivel | `cdp`, `cdp_events`, `batch`, `status` |

### Interceptar red

```jsonc
// Responder con un mock
{ "action": "add", "rule": { "url": "*/api/users", "action": "fulfill", "status": 200,
  "headers": { "content-type": "application/json" }, "body": "[]" } }

// Reescribir una respuesta
{ "action": "add", "rule": { "url": "*/api/plan", "stage": "response", "action": "modify",
  "modify": { "replaceBody": [{ "find": "free", "replace": "pro" }] } } }

// Retener para decidir después con intercept_paused
{ "action": "add", "rule": { "url": "*/checkout", "action": "hold", "holdMs": 60000 } }
```

`intercept action=list` muestra aciertos y `lastError` de cada regla. Una regla que falla deja pasar el request original.

`intercept` trabaja por pestaña, o en todas con `allTabs`, y requiere debugger. `global_rules` afecta a todo el navegador sin debugger, pero solo bloquea, redirige o cambia headers.

## Controles del usuario

El popup tiene controles que el agente no puede cambiar. Las páginas de extensiones y `chrome://` están bloqueadas para él.

- **Permitir control**: al apagarlo se sueltan todas las pestañas, se borran las reglas y se rechazan los comandos.
- **Ocultar secretos**: quita cookies, headers de autenticación y campos tipo `password` o `token` de lo que recibe el modelo.
- **Dominios bloqueados**: el agente no puede leer, navegar ni actuar en ellos. Trae bancos peruanos, PayPal, Binance y gestores de contraseñas. Edítala a tu gusto.

## Seguridad

Esta extensión tiene acceso total al navegador. Conviene entender estos límites:

- **Todo lo que el agente lee va a tu proveedor de modelo.** Eso incluye páginas de sesiones iniciadas.
- **Las páginas pueden intentar manipular al agente** con instrucciones escritas en su contenido. El servidor indica al modelo que las trate como datos, pero esa defensa depende del modelo, no es una barrera técnica. Para trabajo sensible usa un perfil de Chrome separado.
- **Ocultar secretos evita fugas accidentales, no un agente hostil.** `evaluate` puede leer lo que vea el JavaScript de la página, como `localStorage` y cookies que no sean HttpOnly.
- **La lista de dominios tiene el mismo límite.** Cubre navegación y herramientas, pero una regla de red o un `fetch` desde otra página podría tocar un dominio listado.
- **La barra amarilla "depurando este navegador" no se oculta a propósito.** Indica que el agente tiene control. Se quita al soltar la pestaña, o solo tras 5 minutos sin uso.

El bridge solo escucha en `127.0.0.1` y exige el origen exacto de la extensión más un token de 256 bits. Rechaza webs, otras extensiones y DNS rebinding. Un proceso local que pueda leer `pairing.json` sí podría conectarse.

## Limitaciones

- Chrome de marca ignora `--load-extension`, por eso la carga es manual.
- `chrome.debugger` no puede adjuntarse a `chrome://` ni a la Chrome Web Store.
- `upload_file` necesita activar **Permitir acceso a URLs de archivo** en los detalles de la extensión.
- `network_conditions` y `emulate` aplican al frame principal. Los iframes de otro origen conservan su red normal; usa `cdp` con `sessionId` si hace falta.
- Si la ventana está minimizada o cubierta, `screenshot` puede tardar unos segundos. Si no responde en 5 s, muestra la pestaña un momento y devuelve la anterior.
- La captura de red empieza cuando llamas `network_capture`. Lo anterior no queda registrado.

## Estructura

```
extension/   Extensión Chrome MV3 (service worker, popup, lib/ con CDP, red, página y políticas)
bridge/      Servidor MCP por stdio + hub WebSocket local (server, link, tools, pairing, setup)
test/unit/   Pruebas de políticas y del enlace (node --test)
test/e2e.mjs Prueba de punta a punta con Chromium real
```

## Desarrollo

```bash
npm test
```

Las pruebas E2E requieren Chromium o Chrome for Testing, porque usan `--load-extension`:

```bash
CHROMIUM_PATH="/ruta/a/chrome.exe" npm run test:e2e
```

`HEADED=1` las corre con ventana visible.

## Contribuir

Issues y pull requests son bienvenidos. Antes de abrir un PR corre `npm test` y, si tocas la extensión o el bridge, también `npm run test:e2e`.

## Créditos

Creado y mantenido por **Angel Gabriel Jacinto Huayllasco** ([@angelgabrieljacintohuayllasco](https://github.com/angelgabrieljacintohuayllasco)).

Si lo usas o lo forkeas, se agradece mantener el crédito y una estrella en el repo.

## Licencia

[MIT](LICENSE) © 2026 Angel Gabriel Jacinto Huayllasco
