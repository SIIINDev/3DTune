const SERIES = [
  { key: 'bt', name: 'стол, цель', token: '--s-bed', dash: [5, 4], width: 1.5, label: false },
  { key: 'ht', name: 'сопло, цель', token: '--s-hot', dash: [5, 4], width: 1.5, label: false },
  { key: 'b', name: 'стол', token: '--s-bed', dash: [], width: 2, label: true },
  { key: 'h', name: 'сопло', token: '--s-hot', dash: [], width: 2, label: true },
];

const PAD = { l: 40, r: 46, t: 10, b: 24 };
const TICK_STEPS = [5, 10, 20, 25, 50, 100, 200];

function niceScale(raw) {
  for (const step of TICK_STEPS) {
    const max = Math.ceil(raw / step) * step;
    if (max / step <= 6) return { max, divisions: max / step };
  }
  const step = Math.ceil(raw / 6 / 100) * 100;
  return { max: step * 6, divisions: 6 };
}
const PLOT_H = 172;

export function createChart(canvas, tooltipEl) {
  const ctx = canvas.getContext('2d');
  let samples = [];
  let windowMs = 5 * 60 * 1000;
  let pointer = null;
  let raf = null;
  let layout = { from: 0, to: 0, w: 0, h: 0 };

  const token = (name) => getComputedStyle(canvas).getPropertyValue(name).trim();

  function height() {
    return PLOT_H + PAD.t + PAD.b;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = height();
    canvas.style.height = `${h}px`;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      draw();
    });
  }

  function visible() {
    const to = Date.now();
    return { from: to - windowMs, to, pts: samples.filter((s) => s.t >= to - windowMs) };
  }

  function draw() {
    const w = canvas.clientWidth || 600;
    const h = height();
    ctx.clearRect(0, 0, w, h);

    const surface = token('--surface') || '#1a1a19';
    const grid = token('--grid') || '#2c2c2a';
    const axis = token('--axis') || '#383835';
    const muted = token('--muted') || '#898781';
    const ink = token('--ink') || '#fff';

    const { from, to, pts } = visible();
    layout = { from, to, w, h };

    let raw = 40;
    for (const s of pts) raw = Math.max(raw, s.h, s.ht, s.b, s.bt);
    const { max, divisions } = niceScale(raw * 1.1);

    const plotW = w - PAD.l - PAD.r;
    const x = (t) => PAD.l + ((t - from) / windowMs) * plotW;
    const y = (v) => PAD.t + PLOT_H * (1 - Math.min(Math.max(v, 0), max) / max);

    ctx.font = `11px ${token('--font') || 'system-ui'}`;
    ctx.lineWidth = 1;

    ctx.strokeStyle = grid;
    ctx.fillStyle = muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= divisions; i++) {
      const v = (max / divisions) * i;
      const gy = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.l, gy);
      ctx.lineTo(w - PAD.r, gy);
      ctx.stroke();
      ctx.fillText(String(Math.round(v)), PAD.l - 6, gy);
    }

    ctx.strokeStyle = axis;
    const baseY = Math.round(y(0)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(PAD.l, baseY);
    ctx.lineTo(w - PAD.r, baseY);
    ctx.stroke();

    ctx.textBaseline = 'top';
    const ticks = plotW < 250 ? 2 : plotW < 430 ? 3 : 4;
    for (let i = 0; i <= ticks; i++) {
      const t = from + (windowMs / ticks) * i;
      const tx = x(t);
      ctx.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center';
      const minsAgo = Math.round((to - t) / 60000);
      ctx.fillStyle = muted;
      ctx.fillText(minsAgo === 0 ? 'сейчас' : `−${minsAgo} мин`, tx, PAD.t + PLOT_H + 7);
    }

    if (pts.length < 2) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = muted;
      ctx.fillText('нет данных', PAD.l + plotW / 2, PAD.t + PLOT_H / 2);
      return;
    }

    for (const s of SERIES) {
      ctx.strokeStyle = token(s.token);
      ctx.lineWidth = s.width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash(s.dash);
      ctx.beginPath();
      pts.forEach((p, i) => {
        const px = x(p.t);
        const py = y(p[s.key]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
    ctx.setLineDash([]);

    const last = pts[pts.length - 1];
    const ends = SERIES.filter((s) => s.label).map((s) => ({
      s,
      px: x(last.t),
      py: y(last[s.key]),
      text: `${last[s.key].toFixed(0)}°`,
    }));
    if (ends.length === 2 && Math.abs(ends[0].py - ends[1].py) < 15) {
      const mid = (ends[0].py + ends[1].py) / 2;
      const [hi, lo] = ends[0].py <= ends[1].py ? [ends[0], ends[1]] : [ends[1], ends[0]];
      hi.ty = mid - 9;
      lo.ty = mid + 9;
    }

    for (const e of ends) {
      const ty = e.ty ?? e.py;
      if (e.ty !== undefined) {
        ctx.strokeStyle = token('--axis');
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(e.px + 4, e.py);
        ctx.lineTo(e.px + 9, ty);
        ctx.stroke();
      }
      ctx.fillStyle = surface;
      ctx.beginPath();
      ctx.arc(e.px, e.py, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = token(e.s.token);
      ctx.beginPath();
      ctx.arc(e.px, e.py, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = ink;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(e.text, e.px + 11, ty);
    }

    if (pointer !== null) drawCrosshair(pts, x, y, surface, axis);
  }

  function nearest(pts, px, x) {
    let best = null;
    let bestD = Infinity;
    for (const p of pts) {
      const d = Math.abs(x(p.t) - px);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  function drawCrosshair(pts, x, y, surface, axis) {
    const p = nearest(pts, pointer.x, x);
    if (!p) return;
    const px = x(p.t);

    ctx.strokeStyle = axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, PAD.t);
    ctx.lineTo(Math.round(px) + 0.5, PAD.t + PLOT_H);
    ctx.stroke();

    for (const s of SERIES) {
      if (!s.label) continue;
      ctx.fillStyle = surface;
      ctx.beginPath();
      ctx.arc(px, y(p[s.key]), 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = token(s.token);
      ctx.beginPath();
      ctx.arc(px, y(p[s.key]), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    showTooltip(p, px);
  }

  function showTooltip(p, px) {
    if (!tooltipEl) return;
    tooltipEl.replaceChildren();

    const time = document.createElement('div');
    time.className = 'tt-time';
    const ago = Math.round((Date.now() - p.t) / 1000);
    time.textContent = ago <= 1 ? 'сейчас' : `${ago} с назад`;
    tooltipEl.appendChild(time);

    for (const s of SERIES) {
      const row = document.createElement('div');
      row.className = 'tt-row';
      const key = document.createElement('i');
      key.className = 'key';
      key.style.background = 'none';
      key.style.backgroundImage = s.dash.length
        ? `repeating-linear-gradient(to right, ${token(s.token)} 0 4px, transparent 4px 7px)`
        : `linear-gradient(${token(s.token)}, ${token(s.token)})`;
      const val = document.createElement('span');
      val.className = 'tt-val';
      val.textContent = `${p[s.key].toFixed(1)}°`;
      const name = document.createElement('span');
      name.className = 'tt-name';
      name.textContent = s.name;
      row.append(key, val, name);
      tooltipEl.appendChild(row);
    }

    tooltipEl.hidden = false;
    const width = tooltipEl.offsetWidth || 150;
    const left = Math.min(Math.max(px - width / 2, 4), layout.w - width - 4);
    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = '4px';
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.hidden = true;
  }

  function onMove(ev) {
    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    if (px < PAD.l - 8 || px > rect.width - PAD.r + 8) {
      pointer = null;
      hideTooltip();
    } else {
      pointer = { x: px };
    }
    schedule();
  }

  function onLeave() {
    pointer = null;
    hideTooltip();
    schedule();
  }

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointercancel', onLeave);

  new ResizeObserver(() => {
    resize();
    draw();
  }).observe(canvas);
  resize();

  return {
    setAll(list) {
      samples = list.slice(-4000);
      schedule();
    },
    push(sample) {
      samples.push(sample);
      if (samples.length > 4000) samples.shift();
      schedule();
    },
    setWindow(ms) {
      windowMs = ms;
      schedule();
    },
    redraw: schedule,
  };
}
