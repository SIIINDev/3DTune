const ASSET_V = new URL(import.meta.url).searchParams.get('v') ?? '';
let createChart;
let createMesh3D;
try {
  ({ createChart } = await import(`./chart.js${ASSET_V ? `?v=${ASSET_V}` : ''}`));
  ({ createMesh3D } = await import(`./mesh3d.js${ASSET_V ? `?v=${ASSET_V}` : ''}`));
} catch (err) {
  document.body.insertAdjacentHTML(
    'afterbegin',
    '<div class="banner" data-level="critical" style="margin:12px"><span class="banner-icon">\u2715</span>' +
      '<span>Не загрузились модули визуализации — обнови страницу. Если не помогло, перезапусти сервер 3DTune.</span></div>',
  );
  throw err;
}

const $ = (id) => document.getElementById(id);
const numeric = (value) => Number(String(value).trim().replace(',', '.'));

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

function readToken() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');
  if (fromHash) {
    localStorage.setItem('3dtune.token', fromHash);
    history.replaceState(null, '', location.pathname);
    return fromHash;
  }
  return localStorage.getItem('3dtune.token') ?? '';
}

const chart = createChart($('chart'), $('tooltip'));
const mesh3d = createMesh3D($('mesh3d'));

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
let meshMode = 'raw';

/* ---------- theme ---------- */

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  chart.redraw();
  mesh3d.redraw();
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

let token = readToken();

function connectWs() {
  if (!token) {
    showPairGate();
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

async function saveAndVerify(okMessage) {
  const result = await rpc('save');
  if (!result.verified) {
    const details = (result.mismatches ?? []).join('; ') || 'принтер не подтвердил значения';
    throw new Error(`M500 отправлен, но проверка через M501/M503 не прошла: ${details}`);
  }
  toast(okMessage, 'good');
  return result;
}

function handle(msg) {
  switch (msg.t) {
    case 'hello':
      // The catalogue lives on the server, so it can only be fetched once the socket is open.
      void loadPlan();
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
  $('persistenceState').textContent = s.persistence?.dirty
    ? 'изменения не сохранены'
    : s.persistence?.verified
      ? 'EEPROM проверена'
      : 'из принтера';

  const connected = c.status === 'connected';
  $('connect').disabled = connected || c.status === 'connecting';
  $('disconnect').disabled = !connected;

  renderHeater('hotend', s.temps.hotend);
  renderHeater('bed', s.temps.bed);
  safe('chartSummary', () => updateChartSummary(s));

  $('posX').textContent = s.position.x.toFixed(2);
  $('posY').textContent = s.position.y.toFixed(2);
  $('posZ').textContent = s.position.z.toFixed(2);
  $('homedState').textContent = ['x', 'y', 'z']
    .map((a) => `${a.toUpperCase()}${s.homed[a] ? '✓' : '·'}`)
    .join('  ');
  $('fanValue').textContent = `${Math.round((s.fan / 255) * 100)}%`;

  // While an axis is un-homed and the printer is busy, its readout is not trustworthy yet — say so.
  const homingNow = s.busy !== null && !(s.homed.x && s.homed.y && s.homed.z);
  for (const [axis, id] of [['x', 'posX'], ['y', 'posY'], ['z', 'posZ']]) {
    const el = $(id);
    if (homingNow && !s.homed[axis]) el.dataset.busy = 'true';
    else delete el.dataset.busy;
  }

  safe('banners', () => renderBanners(s));
  safe('endstops', () => renderEndstops(s.endstops));
  safe('probing', () => renderProbing(s.probing));
  safe('mesh', () => renderMesh(s.leveling));
  safe('screws', () => renderScrews(s));
  safe('zWizard', () => renderZWizard(s));
  safe('commissioning', () => {
    // Probe-only steps are hidden when the firmware reports no probe, so this follows capabilities.
    const probeKnown = s.connection.caps.Z_PROBE !== undefined;
    if (plan && probeKnown && lastProbeCap !== s.connection.caps.Z_PROBE) {
      lastProbeCap = s.connection.caps.Z_PROBE;
      renderCommissioning();
    }
  });
  safe('leveling', () => {
    $('levelingState').textContent = s.leveling.on ? 'компенсация включена' : 'компенсация выключена';
    const fade = s.settings?.M420?.Z;
    // Do not fight the user mid-edit: the field only follows the printer while it is not focused.
    if (fade !== undefined && document.activeElement !== $('fadeHeight')) $('fadeHeight').value = fade;
  });
  safe('firmwareOnly', () => renderFirmwareOnly(s));
  safe('settings', () => renderSettings(s.settings));
  safe('probe', () => renderProbe(s));
  safe('esteps', () => renderESteps(s));
  safe('pidTarget', () => {
    const bedButton = document.querySelector('#pidTarget button[data-target="bed"]');
    if (bedButton) bedButton.disabled = connected && s.settings.M304 === undefined;
  });
}

/* S7/S11: the temperature ceilings are a host-side assumption about this machine, deliberately
   below the firmware's kill points, and Marlin reports neither over serial. Saying so where the
   user types a target is the difference between a limit they can reason about and one that looks
   arbitrary. */
function renderFirmwareOnly(s) {
  const limits = s.limits;
  if (limits) {
    $('limitsNote').textContent =
      `Потолки 3DTune: сопло ${limits.hotendMax} °C, стол ${limits.bedMax} °C; выше ` +
      `${limits.confirmAboveHotend} °C нужно подтверждение. Это рабочие пределы хоста, а не пределы ` +
      'прошивки — Marlin их по serial не сообщает. Меняются в ~/.3dtune/config.json.';
  }

  const mesh = s.leveling?.mesh;
  $('firmwareMeshInfo').textContent = mesh?.length
    ? `сейчас ${mesh[0]?.length ?? 0}×${mesh.length} точек`
    : 'определяются прошивкой';
}

function safe(what, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`3DTune: render step "${what}" failed`, err);
  }
}

/* The canvas is role=img, so its data is unreachable without vision and a fixed aria-label would
   also go stale. This text twin carries the same numbers the plot shows. */
function updateChartSummary(s) {
  const el = $('chartSummary');
  if (!el) return;
  const part = (name, h) =>
    `${name}: ${h.current.toFixed(1)} градусов, ${h.target > 0 ? `цель ${h.target.toFixed(0)}` : 'нагрев выключен'}`;
  const text = `${part('сопло', s.temps.hotend)}. ${part('стол', s.temps.bed)}.`;
  el.textContent = text;
  $('chart')?.setAttribute('aria-label', `График температур. ${text}`);
}

function renderHeater(which, h) {
  const meter = document.querySelector(`.meter[data-series="${which}"]`);
  if (meter) {
    // Breathe only while power is actually going in, not merely because a target is set.
    if (h.target > 0 && h.power > 0.02) meter.dataset.heating = 'true';
    else delete meter.dataset.heating;
  }
  $(`${which}Value`).textContent = `${h.current.toFixed(1)}°`;
  $(`${which}Sub`).textContent = h.target > 0 ? `цель ${h.target.toFixed(0)}°` : 'нагрев выключен';
  $(`${which}Power`).style.width = `${Math.round(Math.min(1, h.power) * 100)}%`;
}

function renderESteps(s) {
  const current = s.settings?.M92?.E;
  $('eStepsCurrent').textContent = Number.isFinite(current) ? Number(current).toFixed(3) : '—';
  const connected = s.connection.status === 'connected';
  $('eStepsExtrude').disabled = !connected || !Number.isFinite(current);
  $('eStepsApply').disabled = !connected || !Number.isFinite(current);
  $('eStepsSave').disabled = !connected;
  updateEStepsPreview();
}

function updateEStepsPreview() {
  const previous = Number(state?.settings?.M92?.E);
  const requested = numeric($('eStepsRequested').value);
  const measured = numeric($('eStepsMeasured').value);
  const out = $('eStepsPreview');
  if (!Number.isFinite(previous) || previous <= 0 || !Number.isFinite(requested) || !Number.isFinite(measured) || measured <= 0) {
    out.textContent = '—';
    return;
  }
  const correction = requested / measured;
  if (correction < 0.5 || correction > 2) {
    out.textContent = 'проверь замер';
    return;
  }
  out.textContent = (previous * correction).toFixed(3);
}

function renderBanners(s) {
  const box = $('banners');
  box.replaceChildren();

  if (s.halted) {
    box.appendChild(banner('critical', '✕', 'Принтер остановлен по M112. Выключи и включи питание платы.'));
  }
  if (s.connection.status === 'error' && (s.temps.hotend.target > 0 || s.temps.bed.target > 0)) {
    box.appendChild(
      banner(
        'critical',
        '✕',
        'USB-связь потеряна при включённом нагреве. 3DTune больше не может гарантировать отключение нагревателей — проверь принтер и при сомнении выключи питание.',
      ),
    );
  }
  for (const text of s.warnings ?? []) {
    box.appendChild(banner('warning', '⚠', text));
  }
  if (s.persistence?.dirty) {
    box.appendChild(banner('warning', '⚠', 'Есть применённые изменения, которые ещё не сохранены в EEPROM принтера.'));
  }
  if (s.persistence?.verified === false) {
    box.appendChild(
      banner('critical', '✕', `Проверка EEPROM не прошла: ${(s.persistence.mismatches ?? []).join('; ')}`),
    );
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
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = triggered ? '●' : '○';
    const label = document.createElement('span');
    label.textContent = `${k}: ${triggered ? 'сработал' : 'открыт'}`;
    chip.append(icon, label);
    box.appendChild(chip);
  }
}

const SCREW_LABEL = {
  frontLeft: 'передний левый',
  frontRight: 'передний правый',
  backLeft: 'задний левый',
  backRight: 'задний правый',
};

/* Grid order matches the physical bed: back row on top, front row at the bottom, so the card sits
   the same way round as the bed in front of you. */
const SCREW_ORDER = ['backLeft', 'backRight', 'frontLeft', 'frontRight'];

/* Progress comes from Marlin's own "Probing point N/M." lines. When a build announces nothing,
   the bar goes indeterminate instead of showing a number nobody measured. */
function renderZWizard(s) {
  const active = s.zOffsetWizard?.active === true;
  $('zWizardStart').hidden = active;
  $('zWizardCancel').hidden = !active;
  const label = $('zWizardState');
  if (!active) {
    label.textContent = '';
    return;
  }
  const centre = s.zOffsetWizard.centre;
  const current = s.settings?.M851?.Z ?? 0;
  label.textContent =
    `идёт: сопло в X${centre.x} Y${centre.y}, M851 Z обнулён (было ${s.zOffsetWizard.originalZ}), ` +
    `сейчас ${current}. Опускай Z до бумаги, затем «Зафиксировать в M851».`;
}

function renderProbing(probing) {
  const box = $('probingLive');
  if (!probing?.active) {
    box.hidden = true;
    box.dataset.active = 'false';
    for (const cell of document.querySelectorAll('.mesh-cell[data-probing="true"]')) {
      delete cell.dataset.probing;
    }
    return;
  }

  box.hidden = false;
  box.dataset.active = 'true';
  const known = typeof probing.total === 'number' && probing.total > 0;
  box.dataset.indeterminate = String(!known);
  $('probingLabel').textContent = known
    ? `прощупывание: точка ${probing.done} из ${probing.total}`
    : 'прощупывание: прошивка не сообщает число точек';
  $('probingFill').style.width = known ? `${Math.min(100, (probing.done / probing.total) * 100)}%` : '';

  // Highlight the cell being measured, using the previous mesh as the layout reference.
  const cells = [...document.querySelectorAll('.mesh-cell')];
  if (known && cells.length === probing.total) {
    cells.forEach((cell) => delete cell.dataset.probing);
    const target = cells[Math.min(cells.length - 1, Math.max(0, probing.done - 1))];
    if (target) target.dataset.probing = 'true';
  }
}

/* A direct G30 measurement beats grid interpolation, but only while it is the newer of the two: a
   later G29 clears it server-side, so whichever source is shown is always the fresher one. */
function renderScrews(s) {
  const measured = s.screwMeasurement;
  if (measured?.advice?.length) {
    renderScrewAdvice(measured.advice, 'измерено G30 прямо в точках винтов');
    return;
  }
  renderScrewAdvice(s.leveling?.analysis?.screws ?? [], 'интерполировано по сетке G29');
}

/* Same card for both sources, but it says which one it is: grid-interpolated advice and directly
   probed advice deserve different amounts of trust. */
function renderScrewAdvice(screws, source) {
  const box = $('screwMap');
  const note = $('screwAssumption');
  box.replaceChildren();
  if (screws.length === 0) {
    box.dataset.empty = 'true';
    const span = document.createElement('span');
    span.className = 'muted small';
    span.textContent = 'нет данных — прощупай стол';
    box.appendChild(span);
    note.textContent = '';
    return;
  }
  box.dataset.empty = 'false';

  const byCorner = new Map(screws.map((screw) => [screw.corner, screw]));
  const back = document.createElement('div');
  back.className = 'bed-orientation';
  back.textContent = '↑ дальняя сторона стола';
  box.appendChild(back);

  for (const corner of SCREW_ORDER) {
    const screw = byCorner.get(corner);
    if (!screw) continue;
    const cell = document.createElement('div');
    cell.className = 'screw';
    cell.dataset.action = screw.action;

    const name = document.createElement('div');
    name.className = 'screw-corner';
    name.textContent = SCREW_LABEL[corner] ?? corner;

    const action = document.createElement('div');
    action.className = 'screw-action';
    const arrow = document.createElement('span');
    arrow.className = 'screw-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    const verb = document.createElement('span');
    if (screw.action === 'leave') {
      arrow.textContent = '✓';
      verb.textContent = 'не трогать';
    } else {
      arrow.textContent = screw.action === 'tighten' ? '↻' : '↺';
      const turns = document.createElement('span');
      turns.className = 'screw-turns';
      turns.textContent = `${screw.turnLabel} об.`;
      verb.textContent = screw.action === 'tighten' ? 'затянуть' : 'ослабить';
      action.append(arrow, verb, turns);
    }
    if (screw.action === 'leave') action.append(arrow, verb);

    const detail = document.createElement('div');
    detail.className = 'screw-detail';
    detail.textContent =
      `высота ${signed(screw.height)} · нужно ${signed(screw.deltaMm)} · ` +
      `X${Math.round(screw.x)} Y${Math.round(screw.y)}`;

    cell.append(name, action, detail);
    box.appendChild(cell);
  }

  const front = document.createElement('div');
  front.className = 'bed-orientation';
  front.textContent = '↓ сторона, обращённая к тебе';
  box.appendChild(front);

  note.textContent =
    `Источник: ${source}. ` +
    'Отсчёт от средней высоты четырёх винтов, поэтому Z-offset почти не сдвигается. ' +
    'Допущения: шаг винта 0.5 мм за оборот (M3) и «затянуть» опускает стол. ' +
    'Проверь направление один раз на своём принтере: если стол пошёл не туда, поменяй ' +
    'bedScrews.tighteningLowersBed в ~/.3dtune/config.json.';
}

function renderMesh(leveling) {
  const mesh = leveling?.mesh;
  const analysis = leveling?.analysis;
  const shown = meshMode === 'curvature' ? analysis?.residuals : mesh;
  const box = $('mesh');
  const scale = $('meshScale');
  box.replaceChildren();
  if (!shown || shown.length === 0) {
    scale.hidden = true;
    $('meshStats').hidden = true;
    mesh3d.setData(null);
    const span = document.createElement('span');
    span.className = 'muted small';
    span.textContent = 'нет данных — выполни G29';
    box.appendChild(span);
    return;
  }

  const flat = shown.flat();
  const maxAbs = Math.max(0.005, ...flat.map(Math.abs));

  /* Only raw heights are editable: a curvature cell is a residual after subtracting the best-fit
     plane, and M421 writes absolute mesh values. Writing a residual would corrupt the mesh. */
  const editable = meshMode === 'raw';
  [...shown].reverse().forEach((row, ri) => {
    const div = document.createElement('div');
    div.className = 'mesh-row';
    const j = shown.length - 1 - ri;
    row.forEach((v, ci) => {
      const cell = document.createElement('div');
      cell.className = 'mesh-cell';
      const k = Math.min(1, Math.abs(v) / maxAbs);
      const pole = v >= 0 ? 'var(--div-hi)' : 'var(--div-lo)';
      cell.style.background = `color-mix(in oklab, ${pole} ${(k * 100).toFixed(1)}%, var(--div-mid))`;
      if (k > 0.5) cell.dataset.pole = 'true';
      cell.textContent = v.toFixed(3);
      cell.title = `точка ${ci + 1}, ряд ${j + 1}: ${v.toFixed(3)} мм`;
      if (editable) {
        cell.dataset.editable = 'true';
        cell.tabIndex = 0;
        cell.setAttribute('role', 'button');
        cell.setAttribute('aria-label', `Точка ${ci + 1}, ряд ${j + 1}: ${v.toFixed(3)} мм. Изменить`);
        const pick = () => openMeshEdit(ci, j, v);
        cell.onclick = pick;
        cell.onkeydown = (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          pick();
        };
      }
      div.appendChild(cell);
    });
    box.appendChild(div);
  });
  if (!editable) closeMeshEdit();

  scale.hidden = false;
  $('meshMin').textContent = `${(-maxAbs).toFixed(3)}`;
  $('meshMax').textContent = `+${maxAbs.toFixed(3)}`;
  mesh3d.setData(shown);

  $('meshInterpretation').textContent = meshMode === 'curvature'
    ? 'Кривизна после вычитания общей плоскости: винтами этот рисунок не убрать.'
    : 'Исходные высоты: общий градиент показывает наклон стола и регулируется винтами.';
  const stats = analysis?.stats;
  $('meshStats').hidden = !stats;
  if (stats) {
    $('meshRange').textContent = `${stats.range.toFixed(3)} мм`;
    $('meshTiltX').textContent = signed(stats.tiltX);
    $('meshTiltY').textContent = signed(stats.tiltY);
    $('meshWarp').textContent = `${stats.maxAbsResidual.toFixed(3)} мм`;
    $('meshCenter').textContent = signed(stats.centerVsCorners);
  }
}

function signed(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)} мм`;
}

let meshEditTarget = null;

function openMeshEdit(i, j, value) {
  meshEditTarget = { i, j };
  $('meshEditPoint').textContent = `${i + 1}, ряд ${j + 1}`;
  $('meshEditCurrent').textContent = value.toFixed(3);
  $('meshEditZ').value = value.toFixed(3);
  $('meshEdit').hidden = false;
  $('meshEditZ').focus();
  $('meshEditZ').select();
}

function closeMeshEdit() {
  meshEditTarget = null;
  $('meshEdit').hidden = true;
}

$('meshEditCancel').onclick = closeMeshEdit;
$('meshEditApply').onclick = async () => {
  if (!meshEditTarget) return;
  const z = numeric($('meshEditZ').value);
  if (!Number.isFinite(z)) {
    toast('Введи число');
    return;
  }
  const { i, j } = meshEditTarget;
  await call('editMeshPoint', { i, j, z }, `точка ${i + 1},${j + 1} записана — не забудь M500`);
  closeMeshEdit();
};

$('applyFadeHeight').onclick = async () => {
  const mm = numeric($('fadeHeight').value);
  const result = await call('setFadeHeight', { mm });
  const state = $('fadeHeightState');
  if (result.reported === null) {
    state.textContent = 'принтер не вернул M420 Z — прочитай M503';
  } else if (Math.abs(result.reported - result.requested) > 0.01) {
    state.textContent = `принтер оставил ${result.reported} мм — похоже, ENABLE_LEVELING_FADE_HEIGHT выключен`;
  } else {
    state.textContent = `подтверждено: ${result.reported} мм`;
  }
};

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
      if (input.value === '' || numeric(input.value) === original) delete edits[key];
      else edits[key] = numeric(input.value);
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
  // A failure must interrupt; a confirmation must not.
  el.setAttribute('role', level === 'good' ? 'status' : 'alert');
  el.setAttribute('aria-live', level === 'good' ? 'polite' : 'assertive');
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
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

/* ---------- sections ---------- */

/* The page is one long document by design — every card keeps its id, its handlers and its place in
   the DOM. The tabs only toggle `hidden`, which [hidden]{display:none!important} also removes from
   the tab order, so nothing has to be re-rendered or re-wired when the section changes. */
const SECTION_STORAGE = '3dtune.section';

function showSection(name) {
  const known = [...$('tabs').querySelectorAll('button')].map((b) => b.dataset.section);
  const target = known.includes(name) ? name : 'overview';
  for (const btn of $('tabs').querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.section === target));
  }
  for (const el of document.querySelectorAll('[data-section]')) {
    if (el.parentElement?.id === 'tabs') continue;
    el.hidden = el.dataset.section !== target;
  }
  try {
    localStorage.setItem(SECTION_STORAGE, target);
  } catch {
    /* remembering the last section is a nicety, not a requirement */
  }
  window.scrollTo({ top: 0 });
}

for (const btn of $('tabs').querySelectorAll('button')) {
  btn.onclick = () => showSection(btn.dataset.section);
}

let startSection = 'overview';
try {
  startSection = localStorage.getItem(SECTION_STORAGE) ?? 'overview';
} catch {
  /* private mode: start on the overview */
}
showSection(startSection);

segment('rangeSel', (btn) => chart.setWindow(Number(btn.dataset.range)));
segment('stepSel', (btn) => {
  jogStep = Number(btn.dataset.step);
});
segment('pidTarget', (btn) => {
  pidTarget = btn.dataset.target;
  $('pidTemp').value = pidTarget === 'bed' ? 60 : 210;
});
segment('meshMode', (btn) => {
  meshMode = btn.dataset.mode;
  if (state) renderMesh(state.leveling);
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
    : call('connect', { kind: 'serial', path: value, baud: numeric($('baud').value) }, 'Подключено');
};

$('disconnect').onclick = () => call('disconnect', {}, 'Отключено');

$('estop').onclick = () => {
  if (!confirm('Аварийная остановка (M112).\n\nПринтер встанет и потребует выключения питания. Продолжить?')) return;
  call('estop', {});
};

document.querySelectorAll('[data-set]').forEach((btn) => {
  btn.onclick = async () => {
    const which = btn.dataset.set;
    const value = numeric($(which === 'hotend' ? 'hotendTarget' : 'bedTarget').value);
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

document.querySelectorAll('[data-probe-action]').forEach((btn) => {
  btn.onclick = () => call('probeAction', { action: btn.dataset.probeAction });
});

document.querySelectorAll('[data-leveling]').forEach((btn) => {
  btn.onclick = () => call('setLeveling', { on: btn.dataset.leveling === 'on' });
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
  if (
    !confirm(
      `M851 Z: ${currentZ} → ${newZ}\n\n` +
        'Значение сразу запишется в EEPROM принтера (M500) и будет перечитано для проверки — ' +
        'оно переживёт выключение питания и будет работать без компьютера.\n\nПрименить?',
    )
  ) {
    return;
  }
  const result = await call('probeOffset', { z: newZ });
  babystepSum = 0;
  $('babystepSum').textContent = '0.000';
  reportPersisted(result, `M851 Z = ${newZ}`);
};

/* The whole point of committing an offset is that it survives a power cycle, so say plainly whether
   the printer confirmed keeping it rather than just reporting that the command was accepted. */
function reportPersisted(result, what) {
  if (result?.persisted?.verified) {
    toast(`${what} записан в EEPROM и подтверждён перечитыванием`, 'good');
  } else if (result?.persisted) {
    toast(
      `${what} применён, но запись не подтвердилась: ${result.persisted.mismatches?.join('; ') || 'принтер не подтвердил'}. ` +
        'После выключения питания значение может потеряться.',
    );
  } else {
    toast(`${what} применён только до выключения питания`, 'good');
  }
}

$('applyProbeOffset').onclick = async () => {
  const params = {};
  for (const f of PROBE_FIELDS) {
    const input = $('probeOffsetFields').querySelector(`input[data-probe="${f}"]`);
    if (input && input.value !== '') params[f.toLowerCase()] = numeric(input.value);
  }
  const result = await call('probeOffset', params);
  probeEdits = {};
  reportPersisted(result, 'M851');
};

async function runBedConfiguration(mode) {
  if (
    !confirm(
      'Полная конфигурация стола:\n\n' +
        '1. G28 — все оси в нуль\n' +
        '2. G29 — прощупать стол зондом\n' +
        '3. включить компенсацию (M420 S1)\n' +
        '4. M500 — записать в EEPROM и перечитать\n\n' +
        'Принтер будет двигаться. Убедись, что стол чист, щуп установлен и на пути ничего нет. Продолжить?',
    )
  ) {
    return;
  }

  const button = $('autoConfigureBed');
  const status = $('autoConfigureStatus');
  const list = $('autoConfigureSteps');
  button.disabled = true;
  status.textContent = 'идёт замер…';
  list.replaceChildren();
  list.hidden = true;

  try {
    const report = await rpc('autoConfigureBed', { confirmed: true, mode });
    list.hidden = false;
    for (const step of report.steps ?? []) {
      const li = document.createElement('li');
      li.dataset.ok = String(step.ok);
      const code = document.createElement('code');
      code.textContent = step.name;
      li.append(code, document.createTextNode(` — ${step.detail}`));
      list.appendChild(li);
    }
    const failed = (report.steps ?? []).filter((step) => !step.ok);
    if (failed.length === 0) {
      status.textContent = 'готово: сетка снята, компенсация включена, записано в EEPROM';
      toast('Стол сконфигурирован и сохранён в принтере', 'good');
    } else {
      status.textContent = `${failed.length} шаг(ов) не прошли — смотри список`;
      toast(`Конфигурация неполная: ${failed[0].name} — ${failed[0].detail}`);
    }
  } catch (err) {
    status.textContent = `ошибка: ${err.message}`;
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

$('autoConfigureBed').onclick = () => runBedConfiguration('full');

$('bedModeMeasure').onclick = () => runBedConfiguration('measureOnly');

$('bedModeScrews').onclick = async () => {
  if (
    !confirm(
      'Замер по 4 точкам винтов:\n\n' +
        'G28, затем G30 в каждой точке винта. Принтер будет двигаться.\n' +
        'Компенсация не включается и в EEPROM ничего не пишется — это замер для работы ключом.\n\nПродолжить?',
    )
  ) {
    return;
  }
  const button = $('bedModeScrews');
  const status = $('autoConfigureStatus');
  button.disabled = true;
  status.textContent = 'замер по винтам…';
  $('autoConfigureSteps').hidden = true;
  try {
    const result = await rpc('measureScrewPoints', { confirmed: true });
    if (result.failed.length > 0) {
      status.textContent = `зонд не сработал в точках: ${result.failed.join(', ')} — повтори замер`;
      toast(`Не удалось замерить ${result.failed.length} из 4 точек. Подсказки по винтам не показаны: неполная база отсчёта.`);
    } else {
      status.textContent = 'замер по винтам готов — подсказки ниже посчитаны по фактическим точкам';
      toast('Замер по 4 винтам выполнен', 'good');
    }
  } catch (err) {
    status.textContent = `ошибка: ${err.message}`;
    toast(err.message);
  } finally {
    button.disabled = false;
  }
};

$('zWizardStart').onclick = async () => {
  if (
    !confirm(
      'Мастер Z-offset:\n\n' +
        '1. M851 Z обнулится (прежнее значение запомнится)\n' +
        '2. G28 — home всех осей\n' +
        '3. сопло встанет в центр стола на Z0\n\n' +
        'Z0 — это высота срабатывания щупа, она выше стола, поэтому сопло не воткнётся.\n' +
        'Прогрей сопло и стол до рабочих температур заранее: горячий стол имеет другую форму.\n\nПродолжить?',
    )
  ) {
    return;
  }
  await call('startZOffsetWizard', { confirmed: true }, 'Мастер запущен: опускай Z до листа бумаги');
};

$('zWizardCancel').onclick = async () => {
  if (!confirm('Отменить мастер и вернуть прежний M851 Z?')) return;
  const result = await call('cancelZOffsetWizard', {});
  toast(`Мастер отменён, M851 Z возвращён в ${result.restoredZ}`, 'good');
};

$('runG29').onclick = async () => {
  if (!confirm('G29 снимет сетку стола. Стол и сопло должны быть в рабочем состоянии, щуп установлен. Продолжить?')) return;
  await call('runBedLeveling', { confirmed: true }, 'Сетка снята');
};

$('motorsOff').onclick = () => call('motorsOff', {});
$('readEndstops').onclick = () => call('readEndstops', {});
$('eStepsRequested').oninput = updateEStepsPreview;
$('eStepsMeasured').oninput = updateEStepsPreview;

$('eStepsExtrude').onclick = async () => {
  const distance = numeric($('eStepsRequested').value);
  const feedrate = numeric($('eStepsFeedrate').value);
  if (!confirm(
    `Принтер подаст ${distance} мм филамента со скоростью ${feedrate} мм/мин.\n\n` +
      `Сопло должно быть нагрето минимум до ${state?.limits?.minExtrudeTemp ?? 170}°C. ` +
      'Поставь метку на филаменте и убедись, что путь подачи свободен.',
  )) return;
  const button = $('eStepsExtrude');
  button.disabled = true;
  $('eStepsStatus').textContent = 'Идёт контрольная подача…';
  try {
    await rpc('eStepsExtrude', { distance, feedrate });
    $('eStepsStatus').textContent = 'Подача завершена. Измерь фактически протянутую длину и введи её ниже.';
    toast('Контрольная подача завершена', 'good');
  } catch (err) {
    $('eStepsStatus').textContent = `Ошибка: ${err.message}`;
    toast(err.message);
  } finally {
    button.disabled = state?.connection?.status !== 'connected';
  }
};

$('eStepsApply').onclick = async () => {
  const requested = numeric($('eStepsRequested').value);
  const measured = numeric($('eStepsMeasured').value);
  const preview = $('eStepsPreview').textContent;
  if (!Number.isFinite(measured) || measured <= 0 || preview === '—' || preview === 'проверь замер') {
    toast('Введи корректную фактически протянутую длину.');
    return;
  }
  if (!confirm(
    `Текущее M92 E${$('eStepsCurrent').textContent} → M92 E${preview}.\n\n` +
      'Применить без записи в EEPROM?',
  )) return;
  try {
    const result = await rpc('calibrateESteps', { requested, measured });
    $('eStepsMeasured').value = '';
    $('eStepsStatus').textContent =
      `Применено: M92 E${result.previous.toFixed(3)} → E${result.next.toFixed(3)}. ` +
      'Для сохранения после перезапуска нажми M500.';
    toast('E-steps применены. EEPROM ещё не записана.', 'good');
  } catch (err) {
    $('eStepsStatus').textContent = `Ошибка: ${err.message}`;
    toast(err.message);
  }
};

$('eStepsSave').onclick = async () => {
  if (!confirm(
    'Сохранить текущие настройки в EEPROM командой M500?\n\n' +
      'EEPROM эмулируется во flash, поэтому лишние записи ограничены.',
  )) return;
  try {
    await saveAndVerify('E-steps сохранены и проверены через M501/M503');
  } catch (err) {
    toast(err.message);
  }
};

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
  try {
    await saveAndVerify('Сохранено в EEPROM и проверено через M501/M503');
  } catch (err) {
    toast(err.message);
  }
};

$('pidRun').onclick = async () => {
  const temp = numeric($('pidTemp').value);
  const cycles = numeric($('pidCycles').value);
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


/* ---------- commissioning wizard ---------- */

let plan = null;
let lastProbeCap = null;
const DONE_KEY = '3dtune.commissioning.done';

function doneSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

function setDone(id, done) {
  const set = doneSet();
  if (done) set.add(id);
  else set.delete(id);
  localStorage.setItem(DONE_KEY, JSON.stringify([...set]));
}

const HAZARD_LABEL = { motion: 'двигает оси', heat: 'нагрев' };
const WIZARD_TARGET = {
  pid: ['cardPid', 'PID автотюн'],
  esteps: ['cardESteps', 'калибровка E-steps'],
  bed: ['cardProbe', 'зонд и сетка стола'],
  probeOffset: ['cardProbe', 'живая подстройка Z'],
  filament: ['filamentPresets', 'пресеты пластика'],
};

function block(kind, label, text) {
  const div = document.createElement('div');
  div.className = 'step-block';
  div.dataset.kind = kind;
  const b = document.createElement('b');
  b.textContent = label;
  const span = document.createElement('span');
  span.textContent = text;
  div.append(b, span);
  return div;
}

function renderCommissioning() {
  if (!plan) return;
  const host = $('commissioningStages');
  const done = doneSet();
  const hideDone = $('commissioningHideDone').checked;
  const hasProbe = state?.connection?.caps?.Z_PROBE !== false;
  host.replaceChildren();

  let total = 0;
  let completed = 0;

  for (const stage of plan.stages) {
    const steps = plan.steps.filter((step) => step.stage === stage.stage && (hasProbe || !step.requiresProbe));
    if (steps.length === 0) continue;
    const doneHere = steps.filter((step) => done.has(step.id)).length;
    total += steps.length;
    completed += doneHere;

    const box = document.createElement('section');
    box.className = 'stage';

    const head = document.createElement('div');
    head.className = 'stage-head';
    const title = document.createElement('div');
    title.className = 'stage-title';
    const name = document.createElement('span');
    name.textContent = stage.title;
    const count = document.createElement('span');
    count.className = 'stage-count';
    count.textContent = `${doneHere} / ${steps.length}`;
    title.append(name, count);
    const intro = document.createElement('div');
    intro.className = 'stage-intro';
    intro.textContent = stage.intro;
    head.append(title, intro);
    box.appendChild(head);

    for (const step of steps) {
      if (hideDone && done.has(step.id)) continue;
      box.appendChild(renderStep(step, done.has(step.id)));
    }
    host.appendChild(box);
  }

  $('commissioningProgress').textContent = total > 0 ? `${completed} из ${total} шагов` : '';
}

function renderStep(step, isDone) {
  const row = document.createElement('div');
  row.className = 'step';
  row.dataset.done = String(isDone);

  const head = document.createElement('div');
  head.className = 'step-head';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = isDone;
  check.setAttribute('aria-label', `отметить выполненным: ${step.title}`);
  check.onchange = () => {
    setDone(step.id, check.checked);
    renderCommissioning();
  };
  const title = document.createElement('div');
  title.className = 'step-title';
  title.textContent = step.title;
  head.append(check, title);
  if (step.hazard !== 'none') {
    const hazard = document.createElement('span');
    hazard.className = 'step-hazard';
    hazard.dataset.hazard = step.hazard;
    hazard.textContent = HAZARD_LABEL[step.hazard] ?? step.hazard;
    head.appendChild(hazard);
  }
  row.appendChild(head);

  const why = document.createElement('div');
  why.className = 'step-why';
  why.textContent = step.why;
  row.append(why);

  if (step.physical) row.appendChild(block('physical', 'сделать руками', step.physical));
  if (step.observe) row.appendChild(block('observe', 'что должно произойти', step.observe));
  if (step.pass) row.appendChild(block('pass', 'критерий прохождения', step.pass));
  if (step.hostCannot) row.appendChild(block('cannot', 'хост этого не умеет', step.hostCannot));

  if (step.gcode?.length) {
    const codes = document.createElement('div');
    codes.className = 'step-gcode';
    for (const command of step.gcode) {
      const span = document.createElement('span');
      span.textContent = command;
      codes.appendChild(span);
    }
    row.appendChild(codes);

    const actions = document.createElement('div');
    actions.className = 'row';
    const run = document.createElement('button');
    run.className = 'primary mini';
    run.textContent = 'Выполнить';
    const result = document.createElement('span');
    result.className = 'step-result';
    run.onclick = async () => {
      if (step.needsConfirm) {
        const warn =
          step.hazard === 'heat'
            ? 'Шаг включает нагрев.'
            : 'Шаг двигает оси. Держи руку у выключателя питания.';
        if (!confirm(`${step.title}\n\n${warn}\n\nКоманды: ${step.gcode.join(', ')}\n\nПродолжить?`)) return;
      }
      run.disabled = true;
      result.textContent = 'выполняется…';
      delete result.dataset.ok;
      try {
        const report = await rpc('runCommissioningStep', { stepId: step.id, confirmed: true });
        const failed = report.commands.filter((c) => !c.ok);
        result.dataset.ok = String(failed.length === 0);
        result.textContent =
          failed.length === 0
            ? `выполнено: ${report.commands.map((c) => c.command).join(' · ')}`
            : `${failed[0].command} — ${failed[0].detail}`;
      } catch (err) {
        result.dataset.ok = 'false';
        result.textContent = err.message;
        toast(err.message);
      } finally {
        run.disabled = false;
      }
    };
    actions.append(run, result);
    row.appendChild(actions);
  } else if (step.useWizard) {
    const target = WIZARD_TARGET[step.useWizard];
    if (target) {
      const actions = document.createElement('div');
      actions.className = 'row';
      const jump = document.createElement('button');
      jump.className = 'ghost mini';
      jump.textContent = `Открыть: ${target[1]}`;
      jump.onclick = () => {
        const el = document.getElementById(target[0]);
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el?.animate?.([{ opacity: 0.45 }, { opacity: 1 }], { duration: 600 });
      };
      actions.appendChild(jump);
      row.appendChild(actions);
    }
  }

  return row;
}

$('commissioningReset').onclick = () => {
  if (!confirm('Сбросить все отметки о выполненных шагах?')) return;
  localStorage.removeItem(DONE_KEY);
  renderCommissioning();
};
$('commissioningHideDone').onchange = renderCommissioning;

/* ---------- filament presets ---------- */

function renderPresets() {
  if (!plan) return;
  const host = $('filamentPresets');
  host.replaceChildren();
  for (const preset of plan.presets) {
    const card = document.createElement('div');
    card.className = 'preset';

    const head = document.createElement('div');
    head.className = 'preset-head';
    const name = document.createElement('span');
    name.className = 'preset-name';
    name.textContent = preset.name;
    const temps = document.createElement('span');
    temps.className = 'preset-temps';
    temps.textContent = `сопло ${preset.hotend}° · стол ${preset.bed}° · обдув ${preset.fan}%`;
    head.append(name, temps);

    const notes = document.createElement('div');
    notes.className = 'preset-notes';
    notes.textContent = preset.notes;

    const slicer = document.createElement('div');
    slicer.className = 'preset-slicer';
    slicer.textContent = preset.slicer;

    const actions = document.createElement('div');
    actions.className = 'row';
    const apply = document.createElement('button');
    apply.className = 'primary mini';
    apply.textContent = 'Выставить температуры';
    apply.onclick = async () => {
      const firstLayer = $('presetFirstLayer').checked;
      const hotend = firstLayer ? preset.firstLayerHotend : preset.hotend;
      const bed = firstLayer ? preset.firstLayerBed : preset.bed;
      if (!confirm(`${preset.name}: сопло ${hotend} °C, стол ${bed} °C, обдув ${preset.fan} %.\n\nВключить нагрев?`)) return;
      await call('applyFilamentPreset', { presetId: preset.id, firstLayer }, `${preset.name}: температуры выставлены`);
    };
    actions.appendChild(apply);

    card.append(head, notes, slicer, actions);
    host.appendChild(card);
  }
}

async function loadPlan() {
  try {
    plan = await rpc('commissioningPlan');
    renderCommissioning();
    renderPresets();
    renderSlicerPresets();
    void loadHandoff();
  } catch {
    /* the wizard is optional chrome; a failure here must not break control */
  }
}


/* ---------- slicer start G-code ---------- */

const SLICER_MAX_CHARS = 32 * 1024;
const SLICER_STORAGE = '3dtune.startGcode';
const SEVERITY_ICON = { critical: '✕', warning: '⚠', info: 'i' };

function renderSlicerPresets() {
  if (!plan) return;
  const select = $('slicerPreset');
  const previous = select.value;
  select.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'не сравнивать';
  select.appendChild(none);
  for (const preset of plan.presets) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = `${preset.name} (${preset.hotend}° / ${preset.bed}°)`;
    select.appendChild(option);
  }
  select.value = previous;
}

function renderSlicerAnalysis(result) {
  const host = $('slicerFindings');
  const verdict = $('slicerVerdict');
  host.replaceChildren();

  const critical = result.findings.filter((f) => f.severity === 'critical').length;
  const warnings = result.findings.filter((f) => f.severity === 'warning').length;
  const parts = [`${result.commandCount} команд`];
  if (critical) parts.push(`${critical} критично`);
  if (warnings) parts.push(`${warnings} предупреждений`);
  if (!critical && !warnings) parts.push('ничего опасного не найдено');
  verdict.textContent = parts.join(' · ');

  if (result.commandCount === 0) {
    host.appendChild(banner('warning', '⚠', 'В блоке нет ни одной команды G-code.'));
    return;
  }

  const summary = document.createElement('p');
  summary.className = 'note';
  const temps = [];
  if (result.temperatures.hotend !== undefined) temps.push(`сопло ${result.temperatures.hotend} °C`);
  if (result.temperatures.bed !== undefined) temps.push(`стол ${result.temperatures.bed} °C`);
  summary.textContent = temps.length
    ? `Файл греет ${temps.join(', ')}.` + (result.material ? ` Ближайший пресет — ${result.material.name}.` : '')
    : 'Температуры в блоке не заданы числами.';
  host.appendChild(summary);

  /* No separate "limits unknown" banner here: the analyzer already emits that as a finding, and
     only when the block actually contains M201/M203/M204/M205 for it to be about. */
  for (const finding of result.findings) {
    const item = document.createElement('div');
    item.className = 'finding';
    item.dataset.level = finding.severity;

    const head = document.createElement('div');
    head.className = 'finding-head';
    const icon = document.createElement('span');
    icon.className = 'banner-icon';
    icon.textContent = SEVERITY_ICON[finding.severity] ?? 'i';
    const title = document.createElement('b');
    title.textContent = finding.title;
    head.append(icon, title);
    if (finding.line > 0) {
      const where = document.createElement('code');
      where.className = 'finding-line';
      where.textContent = `строка ${finding.line}: ${finding.source}`;
      head.appendChild(where);
    }

    const detail = document.createElement('div');
    detail.className = 'finding-detail';
    detail.textContent = finding.detail;

    item.append(head, detail);
    if (finding.fix) {
      const fix = block('fix', 'Что сделать', finding.fix);
      item.appendChild(fix);
    }
    host.appendChild(item);
  }
}

async function analyzeStartGcode() {
  const text = $('slicerInput').value;
  if (text.trim() === '') {
    toast('Вставь стартовый или конечный блок из слайсера');
    return;
  }
  if (text.length > SLICER_MAX_CHARS) {
    toast(`Слишком много текста (${text.length} символов). Нужно только начало файла — до первого слоя.`);
    return;
  }
  try {
    localStorage.setItem(SLICER_STORAGE, text);
  } catch {
    /* private mode or a full quota must not block the analysis itself */
  }
  const presetId = $('slicerPreset').value;
  const result = await call('analyzeStartGcode', presetId ? { text, presetId } : { text });
  renderSlicerAnalysis(result);
}

$('slicerAnalyze').onclick = () => void analyzeStartGcode();
$('slicerClear').onclick = () => {
  $('slicerInput').value = '';
  $('slicerFindings').replaceChildren();
  $('slicerVerdict').textContent = '';
  try {
    localStorage.removeItem(SLICER_STORAGE);
  } catch {
    /* nothing to clean up if storage is unavailable */
  }
};

try {
  $('slicerInput').value = localStorage.getItem(SLICER_STORAGE) ?? '';
} catch {
  /* storage is a convenience here, not a dependency */
}


/* ---------- what to hand back to the slicer ---------- */

const SOURCE_LABEL = { M503: 'из прошивки', host: 'из профиля машины', assumption: 'допущение' };

function renderHandoff(result) {
  const rowsHost = $('curaRows');
  rowsHost.replaceChildren();
  for (const row of result.cura.rows) {
    const line = document.createElement('div');
    line.className = 'handoff-row';
    line.dataset.source = row.source;
    const field = document.createElement('span');
    field.className = 'handoff-field';
    field.textContent = row.field;
    const value = document.createElement('b');
    value.textContent = row.value;
    const source = document.createElement('span');
    source.className = 'small muted';
    source.textContent = row.note ? `${SOURCE_LABEL[row.source]} · ${row.note}` : SOURCE_LABEL[row.source];
    line.append(field, value, source);
    rowsHost.appendChild(line);
  }

  const missing = $('curaMissing');
  missing.hidden = result.cura.missing.length === 0;
  missing.textContent = result.cura.missing.length
    ? `Прошивка не сообщила: ${result.cura.missing.join(', ')}. Прочитай M503 на подключённом принтере.`
    : '';

  $('startBlock').textContent = result.block.start.join('\n');
  $('endBlock').textContent = result.block.end.join('\n');
  const notes = $('handoffNotes');
  notes.replaceChildren();
  for (const note of result.block.notes) {
    const li = document.createElement('li');
    li.textContent = note;
    notes.appendChild(li);
  }
}

async function loadHandoff() {
  try {
    renderHandoff(await rpc('slicerHandoff'));
  } catch {
    /* the handoff is a read-only derivation; failing to build it must not break control */
  }
}

async function copyBlock(id, label) {
  const text = $(id).textContent;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    $('handoffCopied').textContent = `${label} скопирован`;
  } catch {
    // Clipboard access needs a secure context; over plain http on the LAN it is simply absent.
    $('handoffCopied').textContent = 'браузер не дал доступ к буферу — выдели текст и скопируй руками';
  }
}

$('handoffRefresh').onclick = () => void loadHandoff();
$('copyStartBlock').onclick = () => void copyBlock('startBlock', 'Start G-code');
$('copyEndBlock').onclick = () => void copyBlock('endBlock', 'End G-code');


/* ---------- pairing ---------- */

function showPairGate() {
  $('pairGate').hidden = false;
  $('pairCode').focus();
}

$('pairForm').onsubmit = async (event) => {
  event.preventDefault();
  const code = $('pairCode').value.trim();
  const error = $('pairError');
  error.hidden = true;
  if (!/^\d{6}$/.test(code)) {
    error.textContent = 'Код — ровно 6 цифр.';
    error.hidden = false;
    return;
  }
  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) {
      error.textContent = body.error ?? 'Код не принят.';
      error.hidden = false;
      $('pairCode').select();
      return;
    }
    localStorage.setItem('3dtune.token', body.token);
    token = body.token;
    $('pairGate').hidden = true;
    connectWs();
    void loadPlan();
  } catch (err) {
    error.textContent = String(err.message ?? err);
    error.hidden = false;
  }
};

$('pairCreate').onclick = async () => {
  try {
    const result = await rpc('createPairingCode');
    const shown = $('pairCodeShown');
    shown.hidden = false;
    shown.textContent = result.code;
    let left = result.expiresInSec;
    $('pairCodeTtl').textContent = `действует ${left} с`;
    clearInterval($('pairCreate').ttlTimer);
    $('pairCreate').ttlTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval($('pairCreate').ttlTimer);
        shown.hidden = true;
        $('pairCodeTtl').textContent = 'код истёк — покажи новый';
        return;
      }
      $('pairCodeTtl').textContent = `действует ${left} с`;
    }, 1000);
    renderPairUrls(result.urls);
  } catch (err) {
    toast(err.message);
  }
};

function renderPairUrls(urls) {
  const box = $('pairUrls');
  box.replaceChildren();
  if (!urls?.length) {
    const span = document.createElement('span');
    span.className = 'muted small';
    span.textContent = 'сервер запущен только на loopback — перезапусти с --host 0.0.0.0';
    box.appendChild(span);
    return;
  }
  for (const entry of urls) {
    const row = document.createElement('div');
    row.className = 'pair-url';
    row.dataset.likely = String(entry.likely);
    const link = document.createElement('span');
    link.textContent = entry.url;
    const copy = document.createElement('button');
    copy.className = 'ghost';
    copy.textContent = 'копировать';
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(entry.url);
        copy.textContent = 'скопировано';
        setTimeout(() => (copy.textContent = 'копировать'), 1500);
      } catch {
        copy.textContent = 'скопируй вручную';
      }
    };
    row.append(link, copy);
    if (!entry.likely) {
      const note = document.createElement('span');
      note.className = 'small muted';
      note.textContent = 'возможно, виртуальный адаптер';
      row.appendChild(note);
    }
    box.appendChild(row);
  }
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  chart.redraw();
  mesh3d.redraw();
});
setInterval(() => chart.redraw(), 1000);
connectWs();
refreshPorts();
