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

export type MeshAnalysis = {
  rows: number;
  columns: number;
  plane: number[][];
  residuals: number[][];
  stats: MeshStats;
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
export function analyzeMesh(mesh: number[][] | null, width: number, height: number): MeshAnalysis | null {
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

  return {
    rows,
    columns,
    plane,
    residuals,
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
