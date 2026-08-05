import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeMesh, KP5L_BED_SCREWS, MeshCollector, screwAdvice } from '../src/printer/mesh.ts';

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

/* The screw advice tells someone which knob to physically turn and how far. A sign error here sends
   them the wrong way, so the direction and the magnitude are both pinned. */
test('a pure front-to-back tilt asks the two low screws to move and leaves the high ones', () => {
  // Row 0 is the front. Front is 0.20 mm LOW, back is 0.20 mm HIGH.
  const mesh = [
    [-0.2, -0.2, -0.2],
    [0, 0, 0],
    [0.2, 0.2, 0.2],
  ];
  const screws = screwAdvice(mesh, 300, 300, KP5L_BED_SCREWS);
  const by = new Map(screws.map((s) => [s.corner, s]));

  // Reference is the mean of the four screws, which sits at 0 for a symmetric tilt.
  const front = by.get('frontLeft')!;
  const back = by.get('backLeft')!;

  assert.ok(front.height < 0, `front reads ${front.height}`);
  assert.ok(back.height > 0, `back reads ${back.height}`);
  assert.ok(front.deltaMm > 0, 'a low corner must be asked to come up');
  assert.ok(back.deltaMm < 0, 'a high corner must be asked to go down');

  // Default geometry: tightening lowers the bed, so raising means loosening.
  assert.equal(front.action, 'loosen');
  assert.equal(back.action, 'tighten');

  // Left and right must agree — the tilt has no X component.
  assert.equal(by.get('frontRight')!.action, front.action);
  assert.equal(by.get('backRight')!.action, back.action);
  assert.equal(by.get('frontRight')!.turnLabel, front.turnLabel);
});

test('turn count follows the thread pitch and is rounded to an executable fraction', () => {
  // 20 mm inset on a 300 mm bed samples 1/15 of the way in, so use a flat step to keep the maths plain.
  const mesh = [
    [-0.25, -0.25],
    [0.25, 0.25],
  ];
  const half = screwAdvice(mesh, 300, 300, { ...KP5L_BED_SCREWS, inset: 0, pitchMm: 0.5, deadbandMm: 0.001 });
  const front = half.find((s) => s.corner === 'frontLeft')!;
  // 0.25 mm to correct at 0.5 mm per turn = half a turn.
  assert.equal(front.turns.toFixed(3), '0.500');
  assert.equal(front.turnLabel, '1/2');

  // The same error on a coarser M4 thread needs fewer turns.
  const coarse = screwAdvice(mesh, 300, 300, { ...KP5L_BED_SCREWS, inset: 0, pitchMm: 1.0, deadbandMm: 0.001 });
  assert.equal(coarse.find((s) => s.corner === 'frontLeft')!.turnLabel, '1/4');
});

test('the tightening convention can be inverted for beds that push instead of pull', () => {
  const mesh = [
    [-0.2, -0.2],
    [0.2, 0.2],
  ];
  const pulls = screwAdvice(mesh, 300, 300, { ...KP5L_BED_SCREWS, inset: 0, tighteningLowersBed: true });
  const pushes = screwAdvice(mesh, 300, 300, { ...KP5L_BED_SCREWS, inset: 0, tighteningLowersBed: false });
  const low = (list: ReturnType<typeof screwAdvice>) => list.find((s) => s.corner === 'frontLeft')!;
  assert.equal(low(pulls).action, 'loosen');
  assert.equal(low(pushes).action, 'tighten');
  assert.equal(low(pulls).turnLabel, low(pushes).turnLabel, 'only the direction flips, not the amount');
});

test('a bed already flat within the deadband is left alone', () => {
  const mesh = [
    [0.004, -0.003],
    [-0.002, 0.005],
  ];
  const screws = screwAdvice(mesh, 300, 300, KP5L_BED_SCREWS);
  assert.equal(screws.length, 4);
  for (const screw of screws) {
    assert.equal(screw.action, 'leave', `${screw.corner} should be left alone`);
    assert.equal(screw.turns, 0);
    assert.equal(screw.turnLabel, '—');
  }
});

test('analyzeMesh carries the screw advice so the UI needs no second computation', () => {
  const analysis = analyzeMesh(
    [
      [-0.1, -0.1, -0.1],
      [0, 0, 0],
      [0.1, 0.1, 0.1],
    ],
    300,
    300,
  );
  assert.ok(analysis);
  assert.equal(analysis?.screws.length, 4);
  assert.ok(Number.isFinite(analysis?.screwReference ?? Number.NaN));
  assert.deepEqual(
    analysis?.screws.map((s) => s.corner).sort(),
    ['backLeft', 'backRight', 'frontLeft', 'frontRight'],
  );
});
