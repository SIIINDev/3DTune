export type MeshStats = {
  min: number;
  max: number;
  range: number;
  mean: number;
  tiltX: number;
  tiltY: number;
  residualMin: number;
  residualMax: number;
  residualRange: number;
  maxAbsResidual: number;
  rmsResidual: number;
  centerVsCorners: number;
};

export type ScrewCorner = 'frontLeft' | 'frontRight' | 'backLeft' | 'backRight';

export type ScrewAdvice = {
  corner: ScrewCorner;
  x: number;
  y: number;
  /** Measured bed height at the screw, taken from the probe grid. */
  height: number;
  /** Signed millimetres the bed must move at this screw. Positive means it must come up. */
  deltaMm: number;
  action: 'tighten' | 'loosen' | 'leave';
  /** Absolute magnitude of the correction, in screw turns. */
  turns: number;
  /** Rounded to a fraction a hand can actually execute, e.g. "1/4" or "1 1/6". */
  turnLabel: string;
};

export type BedScrewGeometry = {
  /** Distance of each screw from the two nearest bed edges. */
  inset: number;
  /** Thread pitch: one full turn moves the bed by this much. M3 = 0.5, M4 = 0.7. */
  pitchMm: number;
  /** True when tightening the knob pulls the bed down (springs under the plate). */
  tighteningLowersBed: boolean;
  /** Corrections below this are noise; turning the screw would do more harm than good. */
  deadbandMm: number;
};

export const KP5L_BED_SCREWS: BedScrewGeometry = {
  inset: 20,
  pitchMm: 0.5,
  tighteningLowersBed: true,
  deadbandMm: 0.02,
};

export type MeshAnalysis = {
  rows: number;
  columns: number;
  plane: number[][];
  residuals: number[][];
  stats: MeshStats;
  /** Reference height the screws are levelled to: the mean of the four screw positions. */
  screwReference: number;
  screws: ScrewAdvice[];
};

export class MeshCollector {
  private active = false;
  private rows: number[][] = [];

  reset(): void {
    this.active = false;
    this.rows = [];
  }

  push(raw: string): number[][] | undefined {
    const line = raw.replace(/^echo\s*:\s?/i, '').trim();
    if (/Leveling Grid|Mesh Bed Level data|Bed Topography Report/i.test(line)) {
      this.active = true;
      this.rows = [];
      return undefined;
    }
    if (!this.active) return undefined;

    const row = parseMeshRow(line);
    if (row) {
      this.rows.push(row);
      return undefined;
    }

    // Column headings and UBL coordinate annotations belong to the report but are not data rows.
    if (/^(?:\d+\s+){1,}\d+$/.test(line) || /\([^)]*\)/.test(line) || line === '') return undefined;

    const rectangular =
      this.rows.length >= 2 &&
      this.rows[0]!.length >= 2 &&
      this.rows.every((candidate) => candidate.length === this.rows[0]!.length);
    const completed = rectangular ? this.rows.map((candidate) => [...candidate]) : undefined;
    this.reset();
    return completed;
  }
}

/** Separate bed tilt from local warp by fitting z = ax + by + c over a rectangular probe grid. */
export function analyzeMesh(
  mesh: number[][] | null,
  width: number,
  height: number,
  screwGeometry: BedScrewGeometry = KP5L_BED_SCREWS,
): MeshAnalysis | null {
  if (!mesh || mesh.length < 2 || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const rows = mesh.length;
  const columns = mesh[0]?.length ?? 0;
  if (columns < 2 || mesh.some((row) => row.length !== columns || row.some((v) => !Number.isFinite(v)))) {
    return null;
  }

  const values = mesh.flat();
  const mean = average(values);
  const xMean = width / 2;
  const yMean = height / 2;
  let xz = 0;
  let yz = 0;
  let xx = 0;
  let yy = 0;

  for (let row = 0; row < rows; row++) {
    const y = (row / (rows - 1)) * height - yMean;
    for (let column = 0; column < columns; column++) {
      const x = (column / (columns - 1)) * width - xMean;
      const centeredZ = (mesh[row]?.[column] ?? mean) - mean;
      xz += x * centeredZ;
      yz += y * centeredZ;
      xx += x * x;
      yy += y * y;
    }
  }

  // A complete rectangular grid is symmetric, so the centered X/Y cross-term is zero.
  const slopeX = xx === 0 ? 0 : xz / xx;
  const slopeY = yy === 0 ? 0 : yz / yy;
  const plane: number[][] = [];
  const residuals: number[][] = [];

  for (let row = 0; row < rows; row++) {
    const y = (row / (rows - 1)) * height - yMean;
    const planeRow: number[] = [];
    const residualRow: number[] = [];
    for (let column = 0; column < columns; column++) {
      const x = (column / (columns - 1)) * width - xMean;
      const fitted = mean + slopeX * x + slopeY * y;
      planeRow.push(fitted);
      residualRow.push((mesh[row]?.[column] ?? fitted) - fitted);
    }
    plane.push(planeRow);
    residuals.push(residualRow);
  }

  const residualValues = residuals.flat();
  const corners = [mesh[0]?.[0], mesh[0]?.[columns - 1], mesh[rows - 1]?.[0], mesh[rows - 1]?.[columns - 1]] as number[];
  const centerRows = centerIndices(rows);
  const centerColumns = centerIndices(columns);
  const centerValues = centerRows.flatMap((row) => centerColumns.map((column) => mesh[row]?.[column] ?? mean));

  const min = Math.min(...values);
  const max = Math.max(...values);
  const residualMin = Math.min(...residualValues);
  const residualMax = Math.max(...residualValues);

  const screws = screwAdvice(mesh, width, height, screwGeometry);
  const screwReference = screws.length > 0 ? average(screws.map((screw) => screw.height)) : mean;

  return {
    rows,
    columns,
    plane,
    residuals,
    screwReference,
    screws,
    stats: {
      min,
      max,
      range: max - min,
      mean,
      tiltX: slopeX * width,
      tiltY: slopeY * height,
      residualMin,
      residualMax,
      residualRange: residualMax - residualMin,
      maxAbsResidual: Math.max(...residualValues.map(Math.abs)),
      rmsResidual: Math.sqrt(average(residualValues.map((v) => v * v))),
      centerVsCorners: average(centerValues) - average(corners),
    },
  };
}

const CORNERS: { corner: ScrewCorner; fx: number; fy: number }[] = [
  { corner: 'frontLeft', fx: 0, fy: 0 },
  { corner: 'frontRight', fx: 1, fy: 0 },
  { corner: 'backLeft', fx: 0, fy: 1 },
  { corner: 'backRight', fx: 1, fy: 1 },
];

/* Turn the bed map into "which knob, which way, how far".
   Levelling target is the MEAN of the four screw heights rather than the highest corner: the
   corrections split up and down, so the existing M851 Z-offset stays roughly valid instead of
   being invalidated by lifting the whole bed. */
export function screwAdvice(
  mesh: number[][],
  width: number,
  height: number,
  geometry: BedScrewGeometry = KP5L_BED_SCREWS,
): ScrewAdvice[] {
  const rows = mesh.length;
  const columns = mesh[0]?.length ?? 0;
  if (rows < 2 || columns < 2 || !(width > 0) || !(height > 0)) return [];
  if (!(geometry.pitchMm > 0)) return [];

  const positions = CORNERS.map(({ corner, fx, fy }) => {
    const x = fx === 0 ? geometry.inset : width - geometry.inset;
    const y = fy === 0 ? geometry.inset : height - geometry.inset;
    return { corner, x, y, height: sampleMesh(mesh, x / width, y / height) };
  });

  const reference = average(positions.map((position) => position.height));

  return positions.map(({ corner, x, y, height: z }) => {
    // Positive mesh value means the bed sits high there, so a high screw must come down.
    const deltaMm = reference - z;
    const magnitude = Math.abs(deltaMm);
    if (magnitude < geometry.deadbandMm) {
      return { corner, x, y, height: z, deltaMm, action: 'leave' as const, turns: 0, turnLabel: '—' };
    }
    const mustRise = deltaMm > 0;
    const action = mustRise === geometry.tighteningLowersBed ? ('loosen' as const) : ('tighten' as const);
    const turns = magnitude / geometry.pitchMm;
    return { corner, x, y, height: z, deltaMm, action, turns, turnLabel: formatTurns(turns) };
  });
}

/** Bilinear sample in normalised grid space, clamped: the probe grid is inset from the bed edges,
    so a screw outside it reads the nearest measured point rather than an extrapolated guess. */
function sampleMesh(mesh: number[][], fx: number, fy: number): number {
  const rows = mesh.length;
  const columns = mesh[0]?.length ?? 0;
  const gx = clamp(fx, 0, 1) * (columns - 1);
  const gy = clamp(fy, 0, 1) * (rows - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(x0 + 1, columns - 1);
  const y1 = Math.min(y0 + 1, rows - 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const v00 = mesh[y0]?.[x0] ?? 0;
  const v10 = mesh[y0]?.[x1] ?? v00;
  const v01 = mesh[y1]?.[x0] ?? v00;
  const v11 = mesh[y1]?.[x1] ?? v00;
  return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
}

/* A hand cannot execute "0.37 turns". Round to twelfths — the clock-face granularity people
   actually manage — and never round a real correction down to nothing. */
function formatTurns(turns: number): string {
  const twelfths = Math.max(1, Math.round(turns * 12));
  const whole = Math.floor(twelfths / 12);
  const remainder = twelfths % 12;
  if (remainder === 0) return `${whole}`;
  const divisor = gcd(remainder, 12);
  const fraction = `${remainder / divisor}/${12 / divisor}`;
  return whole === 0 ? fraction : `${whole} ${fraction}`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function centerIndices(length: number): number[] {
  const left = Math.floor((length - 1) / 2);
  const right = Math.ceil((length - 1) / 2);
  return left === right ? [left] : [left, right];
}

function parseMeshRow(line: string): number[] | null {
  if (!/[.+-]/.test(line)) return null;
  let body = line;
  const pipe = body.indexOf('|');
  if (pipe >= 0) {
    body = body.slice(pipe + 1).replace(/\|.*$/, '');
  } else {
    const indexed = /^\d+\s+(.+)$/.exec(body);
    if (indexed) body = indexed[1] ?? '';
  }
  const tokens = body.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || !tokens.every((token) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token))) {
    return null;
  }
  const values = tokens.map(Number);
  return values.every(Number.isFinite) ? values : null;
}
