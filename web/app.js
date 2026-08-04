const ASSET_V = new URL(import.meta.url).searchParams.get('v') ?? '';
let createChart;
try {
  ({ createChart } = await import(`./chart.js${ASSET_V ? `?v=${ASSET_V}` : ''}`));
} catch (err) {
  document.body.insertAdjacentHTML(
    'afterbegin',
    '<div class="banner" data-level="critical" style="margin:12px"><span class="banner-icon">\u2715</span>' +
      '<span>Не загрузился chart.js — обнови страницу. Если не помогло, перезапусти сервер 3DTune.</span></div>',
  );
  throw err;
}

const $ = (id) => document.getElementById(id);

const SETTING_META = {
  M92: { desc: 'шаги на мм', fields: ['X', 'Y', 'Z', 'E'], step: 0.01 },
  M203: { desc: 'макс. скорости, мм/с', fields: ['X', 'Y', 'Z', 'E'], step: 1 },
  M201: { desc: 'макс. ускорения, мм/с²', fields: ['X', 'Y', 'Z', 'E'], step: 10 },
  M204: { desc: 'ускорения: печать / ретракт / холостой', fields: ['P', 'R', 'T'], step: 10 },
  M205: { desc: 'jerk и junction deviation', fields: ['X', 'Y', 'Z', 'E', 'J', 'S', 'T', 'B'], step: 0.1 },
  M206: { desc: 'home offset, мм', fields: ['X', 'Y', 'Z'], step: 0.01 },
  M301: { desc: 'PID сопла', fields: ['P', 'I', 'D'], step: 0.01 },
  M304: { desc: 'PID стола', fields: ['P', 'I', 'D'], step: 0.001 },
  M900: { desc: 'linear advance K', fields: ['K'], step: 0.01 },
};

const PROBE_FIELDS = ['X', 'Y', 'Z'];

const token = new URLSearchParams(location.hash.slice(1)).get('t') ?? localStorage.getItem('3dtune.token') ?? '';
if (new URLSearchParams(location.hash.slice(1)).get('t')) {
  localStorage.setItem('3dtune.token', token);
  history.replaceState(null, '', location.pathname);
}

const chart = createChart($('chart'), $('tooltip'));

let ws = null;
let backoff = 500;
let rpcId = 1;
const pending = new Map();
let state = null;
let jogStep = 1;
let pidTarget = 'hotend';
let pidCollecting = false;
let edits = {};
let probeEdits = {};
let babystepSum = 0;

/* ---------- theme ---------- */

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  chart.redraw();
}
applyTheme(localStorage.getItem('3dtune.theme'));

$('themeToggle').onclick = () => {
  const current = document.documentElement.dataset.theme;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const next = current ? (current === 'dark' ? 'light' : 'dark') : dark ? 'light' : 'dark';
  localStorage.setItem('3dtune.theme', next);
  applyTheme(next);
};

/* ---------- transport ---------- */

function deviceLabel() {
  let label = localStorage.getItem('3dtune.label');
  if (!label) {
    const ua = navigator.userAgent;
    label = /iPhone|iPad|Android/.test(ua) ? 'телефон' : /Macintosh/.test(ua) ? 'мак' : 'пк';
    localStorage.setItem('3dtune.label', label);
  }
  return label;
}

function connectWs() {
  if (!token) {
    toast('Нет токена. Открой ссылку с #t=… из консоли сервера.');
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    backoff = 500;
    ws.send(JSON.stringify({ t: 'hello', label: deviceLabel() }));
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => {
    setStatus('error', 'нет связи с сервером 3DTune');
    for (const [, p] of pending) p.reject(new Error('соединение закрыто'));
    pending.clear();
    setTimeout(connectWs, backoff);
    backoff = Math.min(8000, backoff * 2);
  };
  ws.onerror = () => {};
}

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) {
      reject(new Error('нет соединения с сервером'));
      return;
    }
    const id = rpcId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ t: 'rpc', id, method, params }));
  });
}

async function call(method, params, okMessage) {
  try {
    const result = await rpc(method, params);
    if (okMessage) toast(okMessage, 'good');
    return result;
  } catch (err) {
    toast(err.message);
    throw err;
  }
}

function handle(msg) {
  switch (msg.t) {
    case 'hello':
      chart.setAll(msg.tempHistory ?? []);
      $('term').replaceChildren();
      (msg.log ?? []).forEach(appendLog);
      renderDevices(msg.clients ?? []);
      applyState(msg.state);
      break;
    case 'state':
      applyState(msg.state);
      break;
    case 'temp':
      chart.push(msg.sample);
      break;
    case 'log':
      appendLog(msg.entry);
      break;
    case 'clients':
      renderDevices(msg.clients);
      break;
    case 'audit':
      if (msg.extra) appendLog({ t: Date.now(), dir: 'sys', text: `[${msg.client}] ${msg.method} ${msg.extra}` });
      break;
    case 'event':
      if (msg.event?.type === 'printerError') toast(`Принтер: ${msg.event.text}`);
      if (msg.event?.type === 'reset') toast('Плата перезагрузилась — состояние перечитано');
      break;
    case 'reply': {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? 'ошибка'));
      break;
    }
  }
}

/* ---------- rendering ---------- */

function setStatus(level, text) {
  const icon = $('statusIcon');
  icon.dataset.state = level;
  icon.textContent = level === 'connected' ? '✓' : level === 'error' ? '!' : level === 'connecting' ? '…' : '•';
  $('statusText').textContent = text;
}

function applyState(s) {
  if (!s) return;
  state = s;
  const c = s.connection;

  if (s.halted) setStatus('error', 'ОСТАНОВЛЕН — нужен power cycle');
  else if (c.status === 'connected') setStatus('connected', s.busy ? `занят: ${s.busy}` : `подключено — ${c.label ?? ''}`);
  else if (c.status === 'connecting') setStatus('connecting', 'подключаюсь…');
  else if (c.status === 'error') setStatus('error', c.error ? `ошибка: ${c.error}` : 'ошибка');
  else setStatus('disconnected', 'не подключено');

  $('fwName').textContent = c.firmware ?? '—';
  $('fwMachine').textContent = c.machine ?? '—';
  $('queueDepth').textContent = s.queueDepth;
  $('saveCount').textContent = s.eepromSaves;

  const connected = c.status === 'connected';
  $('connect').disabled = connected || c.status === 'connecting';
  $('disconnect').disabled = !connected;

  renderHeater('hotend', s.temps.hotend);
  renderHeater('bed', s.temps.bed);

  $('posX').textContent = s.position.x.toFixed(2);
  $('posY').textContent = s.position.y.toFixed(2);
  $('posZ').textContent = s.position.z.toFixed(2);
  $('homedState').textContent = ['x', 'y', 'z']
    .map((a) => `${a.toUpperCase()}${s.homed[a] ? '✓' : '·'}`)
    .join('  ');
  $('fanValue').textContent = `${Math.round((s.fan / 255) * 100)}%`;

  safe('banners', () => renderBanners(s));
  safe('endstops', () => renderEndstops(s.endstops));
  safe('mesh', () => renderMesh(s.leveling.mesh));
  safe('leveling', () => {
    $('levelingState').textContent = s.leveling.on ? 'компенсация включена' : 'компенсация выключена';
  });
  safe('settings', () => renderSettings(s.settings));
  safe('probe', () => renderProbe(s));
  safe('pidTarget', () => {
    const bedButton = document.querySelector('#pidTarget button[data-target="bed"]');
    if (bedButton) bedButton.disabled = connected && s.settings.M304 === undefined;
  });
}

function safe(what, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`3DTune: render step "${what}" failed`, err);
  }
}

function renderHeater(which, h) {
  $(`${which}Value`).textContent = `${h.current.toFixed(1)}°`;
  $(`${which}Sub`).textContent = h.target > 0 ? `цель ${h.target.toFixed(0)}°` : 'нагрев выключен';
  $(`${which}Power`).style.width = `${Math.round(Math.min(1, h.power) * 100)}%`;
}

function renderBanners(s) {
  const box = $('banners');
  box.replaceChildren();

  if (s.halted) {
    box.appendChild(banner('critical', '✕', 'Принтер остановлен по M112. Выключи и включи питание платы.'));
  }
  for (const text of s.warnings ?? []) {
    box.appendChild(banner('warning', '⚠', text));
  }
}

function banner(level, icon, text) {
  const div = document.createElement('div');
  div.className = 'banner';
  div.dataset.level = level;
  const i = document.createElement('span');
  i.className = 'banner-icon';
  i.textContent = icon;
  const span = document.createElement('span');
  span.textContent = text;
  div.append(i, span);
  return div;
}

function renderDevices(clients) {
  $('devices').textContent = clients.length > 1 ? clients.map((c) => c.label).join(' · ') : '';
}

function renderEndstops(map) {
  const box = $('endstops');
  const keys = Object.keys(map ?? {}).sort();
  box.replaceChildren();
  if (keys.length === 0) {
    const span = document.createElement('span');
    span.className = 'muted small';
    span.textContent = 'нет данных';
    box.appendChild(span);
    return;
  }
  for (const k of keys) {
    const triggered = map[k] === 'triggered';
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.state = triggered ? 'triggered' : 'open';
    const icon = document.createElement('span');
    icon.className = 'chip-icon';
    icon.textContent = triggered ? '●' : '○';
    const label = document.createElement('span');
    label.textContent = `${k}: ${triggered ? 'сработал' : 'открыт'}`;
    chip.append(icon, label);
    box.appendChild(chip);
  }
}

function renderMesh(mesh) {
  const box = $('mesh');
  const scale = $('meshScale');
  box.replaceChildren();
  if (!mesh || mesh.length === 0) {
    scale.hidden = true;
    const span = document.createElement('span');
    span.className = 'muted small';
    span.textContent = 'нет данных — выполни G29';
    box.appendChild(span);
    return;
  }

  const flat = mesh.flat();
  const maxAbs = Math.max(0.005, ...flat.map(Math.abs));

  [...mesh].reverse().forEach((row, ri) => {
    const div = document.createElement('div');
    div.className = 'mesh-row';
    row.forEach((v, ci) => {
      const cell = document.createElement('div');
      cell.className = 'mesh-cell';
      const k = Math.min(1, Math.abs(v) / maxAbs);
      const pole = v >= 0 ? 'var(--div-hi)' : 'var(--div-lo)';
      cell.style.background = `color-mix(in oklab, ${pole} ${(k * 100).toFixed(1)}%, var(--div-mid))`;
      if (k > 0.5) cell.dataset.pole = 'true';
      cell.textContent = v.toFixed(3);
      cell.title = `точка ${ci + 1}, ряд ${mesh.length - ri}: ${v.toFixed(3)} мм`;
      div.appendChild(cell);
    });
    box.appendChild(div);
  });

  scale.hidden = false;
  $('meshMin').textContent = `${(-maxAbs).toFixed(3)}`;
  $('meshMax').textContent = `+${maxAbs.toFixed(3)}`;
}

function renderProbe(s) {
  const hasProbe = s.connection.caps.Z_PROBE !== false;
  $('probeUnavailable').hidden = hasProbe;
  $('probeControls').hidden = !hasProbe;
  if (!hasProbe) return;

  const box = $('probeOffsetFields');
  const current = s.settings.M851 ?? {};
  if (box.childElementCount !== PROBE_FIELDS.length) {
    box.replaceChildren();
    for (const f of PROBE_FIELDS) {
      const wrap = document.createElement('label');
      wrap.className = 'set-field';
      const name = document.createElement('span');
      name.textContent = f;
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.01';
      input.dataset.probe = f;
      input.oninput = () => {
        probeEdits[f] = input.value;
        input.dataset.dirty = String(String(current[f] ?? '') !== input.value);
      };
      wrap.append(name, input);
      box.appendChild(wrap);
    }
  }
  for (const f of PROBE_FIELDS) {
    const input = box.querySelector(`input[data-probe="${f}"]`);
    if (input && document.activeElement !== input && probeEdits[f] === undefined) {
      input.value = current[f] !== undefined ? String(current[f]) : '';
      input.dataset.dirty = 'false';
    }
  }
}

function renderSettings(settings) {
  const box = $('settings');
  const codes = Object.keys(settings ?? {}).filter((c) => SETTING_META[c]);
  if (codes.length === 0) {
    delete box.dataset.signature;
    box.replaceChildren();
    const span = document.createElement('span');
    span.className = 'muted small';
    span.textContent = 'нет данных — нажми «Прочитать M503»';
    box.appendChild(span);
    return;
  }

  codes.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const signature = codes.join(',');
  if (box.dataset.signature !== signature) {
    box.dataset.signature = signature;
    box.replaceChildren();
    for (const code of codes) box.appendChild(settingGroup(code, settings[code]));
  }

  for (const code of codes) {
    for (const [field, value] of Object.entries(settings[code])) {
      const input = box.querySelector(`input[data-code="${code}"][data-field="${field}"]`);
      if (!input || document.activeElement === input) continue;
      const key = `${code}.${field}`;
      if (edits[key] !== undefined) continue;
      input.value = String(value);
      input.dataset.dirty = 'false';
    }
  }
  renderPending();
}

function settingGroup(code, params) {
  const meta = SETTING_META[code];
  const group = document.createElement('div');
  group.className = 'set-group';

  const head = document.createElement('div');
  head.className = 'set-head';
  const codeEl = document.createElement('span');
  codeEl.className = 'set-code';
  codeEl.textContent = code;
  const desc = document.createElement('span');
  desc.className = 'set-desc';
  desc.textContent = meta.desc;
  head.append(codeEl, desc);

  const fields = document.createElement('div');
  fields.className = 'set-fields';
  for (const field of meta.fields) {
    if (params[field] === undefined) continue;
    const wrap = document.createElement('label');
    wrap.className = 'set-field';
    const name = document.createElement('span');
    name.textContent = field;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = String(meta.step);
    input.dataset.code = code;
    input.dataset.field = field;
    input.value = String(params[field]);
    input.oninput = () => {
      const key = `${code}.${field}`;
      const original = state?.settings?.[code]?.[field];
      if (input.value === '' || Number(input.value) === original) delete edits[key];
      else edits[key] = Number(input.value);
      input.dataset.dirty = String(edits[key] !== undefined);
      renderPending();
    };
    wrap.append(name, input);
    fields.appendChild(wrap);
  }

  group.append(head, fields);
  return group;
}

function pendingCommands() {
  const byCode = {};
  for (const [key, value] of Object.entries(edits)) {
    const [code, field] = key.split('.');
    (byCode[code] ??= {})[field] = value;
  }
  return Object.entries(byCode).map(
    ([code, params]) => `${code} ${Object.entries(params).map(([f, v]) => `${f}${v}`).join(' ')}`,
  );
}

function renderPending() {
  const commands = pendingCommands();
  const box = $('pending');
  box.hidden = commands.length === 0;
  const list = $('pendingList');
  list.replaceChildren();
  for (const cmd of commands) {
    const li = document.createElement('li');
    li.textContent = cmd;
    list.appendChild(li);
  }
}

function appendLog(entry) {
  const term = $('term');
  const nearBottom = term.scrollTop + term.clientHeight >= term.scrollHeight - 40;
  const span = document.createElement('span');
  span.className = /^(Error|!!)/i.test(entry.text) ? 'err' : entry.dir;
  const prefix = entry.dir === 'tx' ? '> ' : entry.dir === 'sys' ? '# ' : '';
  span.textContent = `${prefix}${entry.text}\n`;
  term.appendChild(span);
  while (term.childNodes.length > 700) term.removeChild(term.firstChild);
  if (nearBottom) term.scrollTop = term.scrollHeight;
  if (pidCollecting && entry.dir === 'rx' && /^(bias:|Ku:|Classic PID|Kp:|PID Autotune)/i.test(entry.text)) {
    $('pidOut').textContent += `${entry.text}\n`;
    $('pidOut').scrollTop = $('pidOut').scrollHeight;
  }
}

function toast(message, level = 'critical') {
  const el = $('toast');
  el.replaceChildren();
  el.dataset.level = level;
  const icon = document.createElement('span');
  icon.textContent = level === 'good' ? '✓' : '⚠';
  const text = document.createElement('span');
  text.textContent = message;
  el.append(icon, text);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, 5000);
}

/* ---------- controls ---------- */

function segment(id, onPick) {
  const group = $(id);
  group.querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      onPick(btn);
    };
  });
}

segment('rangeSel', (btn) => chart.setWindow(Number(btn.dataset.range)));
segment('stepSel', (btn) => {
  jogStep = Number(btn.dataset.step);
});
segment('pidTarget', (btn) => {
  pidTarget = btn.dataset.target;
  $('pidTemp').value = pidTarget === 'bed' ? 60 : 210;
});

async function refreshPorts() {
  const select = $('portSelect');
  select.replaceChildren();
  select.appendChild(new Option('mock:// встроенный эмулятор Marlin', 'mock'));
  try {
    const ports = await rpc('listPorts');
    for (const p of ports) {
      const label = `${p.likelyPrinter ? '★ ' : ''}${p.path}${p.manufacturer ? ` — ${p.manufacturer}` : ''}`;
      select.appendChild(new Option(label, p.path));
    }
    if (ports.length > 0) select.selectedIndex = 1;
  } catch {
    /* mock-only list */
  }
}

$('refreshPorts').onclick = refreshPorts;

$('connect').onclick = () => {
  const value = $('portSelect').value;
  return value === 'mock'
    ? call('connect', { kind: 'mock' }, 'Подключено к эмулятору')
    : call('connect', { kind: 'serial', path: value, baud: Number($('baud').value) }, 'Подключено');
};

$('disconnect').onclick = () => call('disconnect', {}, 'Отключено');

$('estop').onclick = () => {
  if (!confirm('Аварийная остановка (M112).\n\nПринтер встанет и потребует выключения питания. Продолжить?')) return;
  call('estop', {});
};

document.querySelectorAll('[data-set]').forEach((btn) => {
  btn.onclick = async () => {
    const which = btn.dataset.set;
    const value = Number($(which === 'hotend' ? 'hotendTarget' : 'bedTarget').value);
    const method = which === 'hotend' ? 'setHotend' : 'setBed';
    try {
      await rpc(method, { value });
    } catch (err) {
      if (/needs explicit confirmation/i.test(err.message) && confirm(`${err.message}\n\nПодтвердить?`)) {
        await call(method, { value, confirmed: true });
      } else {
        toast(err.message);
      }
    }
  };
});

document.querySelectorAll('[data-off]').forEach((btn) => {
  btn.onclick = () => call(btn.dataset.off === 'hotend' ? 'setHotend' : 'setBed', { value: 0 });
});

document.querySelectorAll('[data-presets]').forEach((group) => {
  group.querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      $(group.dataset.presets === 'hotend' ? 'hotendTarget' : 'bedTarget').value = btn.dataset.t;
    };
  });
});

document.querySelectorAll('[data-jog]').forEach((btn) => {
  btn.onclick = () => {
    const axis = btn.dataset.jog;
    const distance = Number(btn.dataset.sign) * (axis === 'E' ? Math.min(jogStep, 10) : jogStep);
    call('jog', { axis, distance });
  };
});

document.querySelectorAll('[data-home]').forEach((btn) => {
  btn.onclick = () => call('home', { axes: btn.dataset.home });
});

document.querySelectorAll('[data-gcode]').forEach((btn) => {
  btn.onclick = () => call('gcode', { command: btn.dataset.gcode });
});

document.querySelectorAll('[data-babystep]').forEach((btn) => {
  btn.onclick = async () => {
    const delta = Number(btn.dataset.babystep);
    await call('babystep', { delta });
    babystepSum += delta;
    $('babystepSum').textContent = babystepSum.toFixed(3);
  };
});

$('commitBabystep').onclick = async () => {
  if (babystepSum === 0) {
    toast('Подстройка не накоплена — сначала покрути Z.');
    return;
  }
  const currentZ = state?.settings?.M851?.Z ?? 0;
  const newZ = Number((currentZ + babystepSum).toFixed(3));
  if (!confirm(`M851 Z: ${currentZ} → ${newZ}\n\nПрименить? Сохранение в EEPROM — отдельной кнопкой.`)) return;
  await call('probeOffset', { z: newZ }, `M851 Z установлен в ${newZ}`);
  babystepSum = 0;
  $('babystepSum').textContent = '0.000';
};

$('applyProbeOffset').onclick = async () => {
  const params = {};
  for (const f of PROBE_FIELDS) {
    const input = $('probeOffsetFields').querySelector(`input[data-probe="${f}"]`);
    if (input && input.value !== '') params[f.toLowerCase()] = Number(input.value);
  }
  await call('probeOffset', params, 'M851 применён');
  probeEdits = {};
};

$('runG29').onclick = async () => {
  if (!confirm('G29 снимет сетку стола. Стол и сопло должны быть в рабочем состоянии, щуп установлен. Продолжить?')) return;
  await call('gcode', { command: 'G29' }, 'Сетка снята');
};

$('motorsOff').onclick = () => call('motorsOff', {});
$('readEndstops').onclick = () => call('readEndstops', {});
$('readSettings').onclick = async () => {
  edits = {};
  probeEdits = {};
  await call('readSettings', {}, 'Настройки прочитаны');
};

$('fan').oninput = debounce(() => call('setFan', { value: Number($('fan').value) }), 250);

$('applySettings').onclick = async () => {
  const commands = pendingCommands();
  if (commands.length === 0) return;
  await call('applySettings', { commands }, 'Применено. В EEPROM пока не записано.');
  edits = {};
  clearDirtyFlags();
  renderPending();
};

function clearDirtyFlags() {
  for (const input of document.querySelectorAll('input[data-dirty="true"]')) {
    input.dataset.dirty = 'false';
  }
}

$('revertSettings').onclick = () => {
  edits = {};
  if (state) {
    for (const input of document.querySelectorAll('.set-group input')) {
      const original = state.settings?.[input.dataset.code]?.[input.dataset.field];
      if (original !== undefined) input.value = String(original);
    }
  }
  clearDirtyFlags();
  renderPending();
};

$('saveEeprom').onclick = async () => {
  const commands = pendingCommands();
  const summary = commands.length ? `${commands.length} изменений будут применены, затем ` : '';
  if (!confirm(`${summary}настройки запишутся в EEPROM (M500).\n\nEEPROM эмулируется во flash, ресурс ~10 000 циклов. Продолжить?`)) return;
  if (commands.length) {
    await call('applySettings', { commands });
    edits = {};
    clearDirtyFlags();
    renderPending();
  }
  await call('save', {}, 'Сохранено в EEPROM');
};

$('pidRun').onclick = async () => {
  const temp = Number($('pidTemp').value);
  const cycles = Number($('pidCycles').value);
  const apply = $('pidApply').checked;
  const what = pidTarget === 'bed' ? 'стол' : 'сопло';
  if (!confirm(`Автотюн PID: ${what}, ${temp}°C, ${cycles} циклов.\n\nНагреватель будет циклически работать несколько минут. Не оставляй принтер без наблюдения.`)) return;

  $('pidOut').textContent = '';
  pidCollecting = true;
  $('pidRun').disabled = true;
  $('pidStatus').textContent = 'идёт автотюн…';
  try {
    const res = await rpc('pidAutotune', { target: pidTarget, temp, cycles, apply });
    $('pidStatus').textContent = res.ok ? 'готово' : `ошибка: ${res.error ?? 'неизвестно'}`;
    if (res.ok && apply) {
      await rpc('readSettings');
      toast('PID применён. Нажми «Сохранить (M500)», чтобы записать.', 'good');
    }
  } catch (err) {
    $('pidStatus').textContent = `ошибка: ${err.message}`;
    toast(err.message);
  } finally {
    pidCollecting = false;
    $('pidRun').disabled = false;
  }
};

$('termForm').onsubmit = async (ev) => {
  ev.preventDefault();
  const input = $('termInput');
  const command = input.value.trim();
  if (!command) return;
  input.value = '';
  try {
    await rpc('gcode', { command });
  } catch (err) {
    toast(err.message);
  }
};

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => chart.redraw());
setInterval(() => chart.redraw(), 1000);
connectWs();
refreshPorts();
