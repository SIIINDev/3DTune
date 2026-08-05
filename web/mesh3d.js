export function createMesh3D(canvas) {
  const ctx = canvas.getContext('2d');
  let grid = null;
  let yaw = -0.65;
  let pitch = 0.72;
  let zoom = 1;
  let drag = null;

  function setData(next) {
    grid = validGrid(next) ? next : null;
    redraw();
  }

  function redraw() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!grid) {
      ctx.fillStyle = css('--muted');
      ctx.font = '12px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('нет данных для 3D-поверхности', rect.width / 2, rect.height / 2);
      return;
    }

    const rows = grid.length;
    const columns = grid[0].length;
    const maxAbs = Math.max(0.005, ...grid.flat().map(Math.abs));
    const points = grid.map((row, rowIndex) =>
      row.map((value, columnIndex) =>
        project(
          (columnIndex / (columns - 1)) * 2 - 1,
          (rowIndex / (rows - 1)) * 2 - 1,
          value / maxAbs,
          rect.width,
          rect.height,
        ),
      ),
    );

    const cells = [];
    for (let row = 0; row < rows - 1; row++) {
      for (let column = 0; column < columns - 1; column++) {
        const vertices = [
          points[row][column],
          points[row][column + 1],
          points[row + 1][column + 1],
          points[row + 1][column],
        ];
        const values = [
          grid[row][column],
          grid[row][column + 1],
          grid[row + 1][column + 1],
          grid[row + 1][column],
        ];
        cells.push({ vertices, value: average(values), depth: average(vertices.map((p) => p.depth)) });
      }
    }
    cells.sort((a, b) => b.depth - a.depth);

    for (const cell of cells) {
      ctx.beginPath();
      ctx.moveTo(cell.vertices[0].x, cell.vertices[0].y);
      for (const point of cell.vertices.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.closePath();
      ctx.fillStyle = surfaceColor(cell.value, maxAbs);
      ctx.fill();
      ctx.strokeStyle = css('--hair', 'rgba(0,0,0,.15)');
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.strokeStyle = css('--ink-2');
    ctx.lineWidth = 1.2;
    for (const row of points) drawLine(row);
    for (let column = 0; column < columns; column++) drawLine(points.map((row) => row[column]));
  }

  function project(x, depth, value, width, height) {
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const rotatedX = x * cosYaw - depth * sinYaw;
    const rotatedDepth = x * sinYaw + depth * cosYaw;
    const vertical = -value * 0.62;
    const screenVertical = vertical * Math.cos(pitch) - rotatedDepth * Math.sin(pitch);
    const finalDepth = vertical * Math.sin(pitch) + rotatedDepth * Math.cos(pitch);
    const scale = Math.min(width, height) * 0.34 * zoom * (3.4 / (3.4 + finalDepth * 0.18));
    return {
      x: width / 2 + rotatedX * scale,
      y: height * 0.53 + screenVertical * scale,
      depth: finalDepth,
    };
  }

  function drawLine(points) {
    if (points.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }

  canvas.addEventListener('pointerdown', (event) => {
    drag = { x: event.clientX, y: event.clientY, yaw, pitch };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    yaw = drag.yaw + (event.clientX - drag.x) * 0.012;
    pitch = clamp(drag.pitch + (event.clientY - drag.y) * 0.008, 0.2, 1.3);
    redraw();
  });
  canvas.addEventListener('pointerup', () => {
    drag = null;
  });
  canvas.addEventListener('pointercancel', () => {
    drag = null;
  });
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoom = clamp(zoom * (event.deltaY > 0 ? 0.92 : 1.08), 0.65, 1.8);
      redraw();
    },
    { passive: false },
  );

  new ResizeObserver(redraw).observe(canvas);
  return { setData, redraw };
}

function validGrid(grid) {
  return Array.isArray(grid) && grid.length >= 2 && grid.every(
    (row) => Array.isArray(row) && row.length === grid[0].length && row.length >= 2 && row.every(Number.isFinite),
  );
}

function surfaceColor(value, maxAbs) {
  const mid = parseHex(css('--div-mid', '#777777'));
  const pole = parseHex(css(value >= 0 ? '--div-hi' : '--div-lo', value >= 0 ? '#e34948' : '#2a78d6'));
  const amount = Math.min(1, Math.abs(value) / maxAbs);
  const mixed = mid.map((channel, index) => Math.round(channel + (pole[index] - channel) * amount));
  return `rgba(${mixed[0]}, ${mixed[1]}, ${mixed[2]}, 0.88)`;
}

function parseHex(value) {
  const hex = value.trim();
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return [127, 127, 127];
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function css(name, fallback = '#777777') {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
