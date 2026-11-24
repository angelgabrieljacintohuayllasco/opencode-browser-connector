const REFRESH_MS = 1500;
const byId = (id) => document.getElementById(id);

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function renderConnection(state) {
  const dot = byId('dot');
  if (!state.enabled) {
    dot.dataset.state = 'off';
    byId('connection').textContent = 'Pausado por ti';
  } else if (state.connected) {
    dot.dataset.state = 'on';
    byId('connection').textContent = 'Conectado a OpenCode';
  } else {
    dot.dataset.state = 'idle';
    byId('connection').textContent = 'Esperando a OpenCode';
  }
}

function renderActivity(items) {
  const list = byId('activity');
  list.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement('li');
      row.dataset.ok = String(item.ok);
      const time = document.createElement('time');
      time.textContent = new Date(item.at).toLocaleTimeString('es-PE', { hour12: false });
      const text = document.createElement('span');
      text.textContent = item.detail ? `${item.tool} ${item.detail}` : item.tool;
      text.title = text.textContent;
      row.append(time, text);
      return row;
    }),
  );
  byId('empty').hidden = items.length > 0;
}

async function refresh({ syncInputs = false } = {}) {
  const state = await send({ type: 'getState' });
  renderConnection(state);
  byId('attached').textContent = state.attachedTabs.length;
  byId('capturing').textContent = state.capturing.length;
  byId('rules').textContent = state.rules;
  byId('paused').textContent = state.paused;
  renderActivity(state.activity);
  if (syncInputs) {
    byId('enabled').checked = state.enabled;
    byId('redact').checked = state.redactSecrets;
    byId('blocked').value = state.blockedDomains.join('\n');
  }
}

byId('enabled').addEventListener('change', async (event) => {
  await send({ type: 'setSettings', patch: { enabled: event.target.checked } });
  refresh();
});

byId('redact').addEventListener('change', (event) => {
  send({ type: 'setSettings', patch: { redactSecrets: event.target.checked } });
});

byId('blocked').addEventListener('change', (event) => {
  const blockedDomains = event.target.value.split('\n').map((line) => line.trim()).filter(Boolean);
  send({ type: 'setSettings', patch: { blockedDomains } });
});

byId('stop').addEventListener('click', async () => {
  await send({ type: 'stopAll' });
  refresh();
});

refresh({ syncInputs: true });
setInterval(refresh, REFRESH_MS);
