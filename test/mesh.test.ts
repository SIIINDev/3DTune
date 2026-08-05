import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeMesh, MeshCollector } from '../src/printer/mesh.ts';

test('mesh analysis removes a perfect tilted plane', () => {
  const mesh = Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: 3 }, (_, column) => 0.2 + column * 0.15 - row * 0.075),
  );
  const analysis = analyzeMesh(mesh, 300, 300);
  assert.ok(analysis);
  assert.ok(Math.abs(analysis.stats.tiltX - 0.3) < 1e-12);
  assert.ok(Math.abs(analysis.stats.tiltY + 0.15) < 1e-12);
  assert.ok(analysis.stats.maxAbsResidual < 1e-12);
  assert.ok(analysis.residuals.flat().every((value) => Math.abs(value) < 1e-12));
});

test('mesh analysis exposes local center curvature separately from tilt', () => {
  const mesh = [
    [-0.1, 0, 0.1],
    [-0.1, 0.2, 0.1],
    [-0.1, 0, 0.1],
  ];
  const analysis = analyzeMesh(mesh, 300, 300);
  assert.ok(analysis);
  assert.ok(Math.abs(analysis.stats.tiltX - 0.2) < 1e-12);
  assert.ok(Math.abs(analysis.stats.tiltY) < 1e-12);
  assert.ok(analysis.stats.maxAbsResidual > 0.15);
  assert.equal(analysis.stats.centerVsCorners, 0.2);
});

test('mesh analysis rejects incomplete or non-finite grids', () => {
  assert.equal(analyzeMesh(null, 300, 300), null);
  assert.equal(analyzeMesh([[0, 1], [0]], 300, 300), null);
  assert.equal(analyzeMesh([[0, 1], [0, Number.NaN]], 300, 300), null);
});

test('mesh collector accepts bilinear, UBL and bare MBL report rows', () => {
  const cases = [
    ['Bilinear Leveling Grid:', '0 1 2', '0 +0.010 -0.020 +0.030', '1 +0.020 -0.010 +0.040', 'ok'],
    ['Bed Topography Report:', '(0,210) (210,210)', '2 | -0.100 +0.000 +0.100 |', '1 | -0.050 +0.020 +0.080 |', 'ok'],
    ['Mesh Bed Level data:', '+0.100 +0.200 +0.300', '+0.000 +0.100 +0.200', 'echo:Bed Leveling ON'],
  ];
  for (const lines of cases) {
    const collector = new MeshCollector();
    let mesh: number[][] | undefined;
    for (const line of lines) mesh = collector.push(line) ?? mesh;
    assert.ok(mesh, `failed format: ${lines[0]}`);
    assert.equal(mesh.length, 2);
    assert.equal(mesh[0]?.length, 3);
  }
});
