import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Printer } from '../src/printer/printer.ts';
import { waitFor } from './support.ts';

/* Three bed routines that answer different questions, plus the Z-offset wizard. The distinction
   that matters: the measure-only mode must NOT hide the error in software, because it exists for the
   pass where you are fixing the bed mechanically. */

test('screw-point mode probes each screw directly and reports every point', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock' });
  try {
    await assert.rejects(() => printer.measureScrewPoints(false), /подтверждение/);

    const result = await printer.measureScrewPoints(true);
    assert.equal(result.failed.length, 0, `failed corners: ${result.failed.join(', ')}`);
    assert.equal(result.points.length, 4);
    assert.deepEqual(
      result.points.map((p) => p.corner).sort(),
      ['backLeft', 'backRight', 'frontLeft', 'frontRight'],
    );

    // The coordinates must be the screw positions, not the grid corners.
    const { bedSize, bedScrews } = printer.limits;
    const front = result.points.find((p) => p.corner === 'frontLeft');
    assert.equal(front?.x, bedScrews.inset);
    assert.equal(front?.y, bedScrews.inset);
    const back = result.points.find((p) => p.corner === 'backRight');
    assert.equal(back?.x, bedSize.x - bedScrews.inset);
    assert.equal(back?.y, bedSize.y - bedScrews.inset);

    for (const point of result.points) assert.ok(Number.isFinite(point.z) && Math.abs(point.z) < 5);
  } finally {
    await printer.disconnect();
  }
});

test('a silently failed probe is reported as failed, never as zero', async () => {
  // Marlin prints nothing when a probe fails. Reading that silence as 0.000 would tell the user to
  // turn a screw that is already correct.
  const printer = new Printer();
  await printer.connect({ kind: 'mock', probeFailsAt: 1 });
  try {
    const result = await printer.measureScrewPoints(true);
    assert.equal(result.points.length, 3, 'the failed point must be omitted, not defaulted');
    assert.equal(result.failed.length, 1);
    assert.ok(!result.points.some((p) => p.z === 0 && result.failed.includes(p.corner)));
  } finally {
    await printer.disconnect();
  }
});

test('screw-point mode is refused when the firmware reports no probe', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock', caps: { Z_PROBE: false } });
  try {
    await assert.rejects(() => printer.measureScrewPoints(true), /поддержке зонда/);
  } finally {
    await printer.disconnect();
  }
});

test('measure-only mode leaves compensation off and writes nothing', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock' });
  try {
    const report = await printer.autoConfigureBed(true, 'measureOnly');
    await waitFor(() => printer.snapshot().leveling.mesh !== null, 'the mesh to be captured');

    assert.ok(report.steps.some((s) => s.name === 'G29' && s.ok), 'it must still probe');
    assert.ok(report.analysis, 'the measurement must be analysed and shown');
    assert.equal(report.saved, null, 'measure-only must not touch the EEPROM');
    assert.equal(
      printer.snapshot().leveling.on,
      false,
      'compensation must stay OFF — this mode exists for the mechanical pass',
    );
    const skipped = report.steps.find((s) => s.name === 'M500');
    assert.match(String(skipped?.detail), /намеренно/, 'the skipped save must be explained, not silent');
  } finally {
    await printer.disconnect();
  }
});

test('full mode still enables compensation and persists it', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock' });
  try {
    const report = await printer.autoConfigureBed(true, 'full');
    assert.equal(printer.snapshot().leveling.on, true);
    assert.equal(report.saved?.verified, true, report.saved?.mismatches.join('; '));
  } finally {
    await printer.disconnect();
  }
});

/* The wizard's whole trick is that zeroing M851 Z makes Z0 the probe trigger height, which sits
   above the bed — so the user always walks the nozzle DOWN towards contact, never into the glass. */
test('the Z-offset wizard zeroes the offset, parks at centre, and remembers what to restore', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock' });
  try {
    await printer.setProbeOffset({ z: -1.75 }, false);
    await assert.rejects(() => printer.startZOffsetWizard(false), /подтверждение/);

    const started = await printer.startZOffsetWizard(true);
    assert.equal(started.originalZ, -1.75, 'the previous offset must be captured before zeroing');
    assert.equal(printer.snapshot().settings['M851']?.['Z'], 0, 'M851 Z must be zeroed for the paper test');

    const wizard = printer.snapshot().zOffsetWizard;
    assert.equal(wizard?.active, true);
    assert.equal(wizard?.originalZ, -1.75);
    assert.equal(wizard?.centre.x, Math.round(printer.limits.bedSize.x / 2));
    assert.equal(wizard?.centre.y, Math.round(printer.limits.bedSize.y / 2));

    await assert.rejects(() => printer.startZOffsetWizard(true), /уже запущен/);
  } finally {
    await printer.disconnect();
  }
});

test('abandoning the wizard restores the original offset instead of leaving it zeroed', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock' });
  try {
    await printer.setProbeOffset({ z: -2.4 }, false);
    await printer.startZOffsetWizard(true);
    assert.equal(printer.snapshot().settings['M851']?.['Z'], 0);

    const cancelled = await printer.cancelZOffsetWizard();
    assert.equal(cancelled.restoredZ, -2.4);
    assert.equal(printer.snapshot().settings['M851']?.['Z'], -2.4, 'a cancelled wizard must not cost the offset');
    assert.equal(printer.snapshot().zOffsetWizard, null);

    await assert.rejects(() => printer.cancelZOffsetWizard(), /не запущен/);
  } finally {
    await printer.disconnect();
  }
});

test('committing during the wizard writes the babystep distance as the offset and persists it', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock' });
  try {
    await printer.setProbeOffset({ z: -1.0 }, false);
    await printer.startZOffsetWizard(true);

    // With the offset zeroed, the distance walked down IS the offset — this is the whole mechanism.
    const walkedDown = -1.42;
    const committed = await printer.setProbeOffset({ z: walkedDown });
    printer.finishZOffsetWizard();

    assert.equal(printer.snapshot().settings['M851']?.['Z'], walkedDown);
    assert.equal(committed.persisted?.verified, true, 'the point of the wizard is that it survives power-off');
    assert.equal(printer.snapshot().zOffsetWizard, null);
  } finally {
    await printer.disconnect();
  }
});

/* The card must name its source, and the label must not outlive the data: interpolated advice and
   directly probed advice earn different trust, so a stale label is a lie about precision. */
test('a direct screw measurement enters state and is superseded by a later grid probe', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock' });
  try {
    assert.equal(printer.snapshot().screwMeasurement, null);

    await printer.measureScrewPoints(true);
    const measured = printer.snapshot().screwMeasurement;
    assert.ok(measured, 'a completed measurement must reach the state, not just the RPC reply');
    assert.equal(measured?.advice.length, 4);
    assert.equal(measured?.points.length, 4);

    // A fresh grid is newer information; the older direct measurement must stop being displayed.
    await printer.runBedLeveling(true);
    await waitFor(() => printer.snapshot().leveling.mesh !== null, 'the mesh to be captured');
    assert.equal(
      printer.snapshot().screwMeasurement,
      null,
      'a later G29 must clear the older direct measurement rather than leave two sources competing',
    );
  } finally {
    await printer.disconnect();
  }
});

test('an incomplete screw measurement produces no advice at all', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock', probeFailsAt: 2 });
  try {
    const result = await printer.measureScrewPoints(true);
    assert.equal(result.points.length, 3);
    assert.deepEqual(result.advice, [], 'levelling to three of four screws is a wrong reference');
    assert.equal(printer.snapshot().screwMeasurement, null, 'partial data must not be shown as advice');
  } finally {
    await printer.disconnect();
  }
});

/* Committing the offset IS the wizard's outcome. If the wizard stays armed afterwards, the UI keeps
   offering "restore the previous offset" next to a value that is already verified in EEPROM, and
   pressing it silently undoes the calibration this whole feature exists to make permanent. */
test('committing an offset ends the Z-offset wizard instead of leaving an undo button armed', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock' });
  try {
    await printer.setProbeOffset({ z: -1.4 }, false);
    await printer.startZOffsetWizard(true);
    assert.equal(printer.snapshot().zOffsetWizard?.active, true);

    await printer.setProbeOffset({ z: -1.85 }, false);
    assert.equal(printer.snapshot().zOffsetWizard, null, 'the wizard must close once Z is written');
    assert.equal(printer.snapshot().settings['M851']?.['Z'], -1.85);

    // With the wizard closed there is nothing left to cancel, so the committed value cannot be lost.
    await assert.rejects(() => printer.cancelZOffsetWizard(), /мастер|wizard/i);
    assert.equal(printer.snapshot().settings['M851']?.['Z'], -1.85);
  } finally {
    await printer.disconnect();
  }
});

test('an X or Y offset edit does not close a running Z-offset wizard', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock' });
  try {
    await printer.startZOffsetWizard(true);
    await printer.setProbeOffset({ x: 27, y: -6 }, false);
    assert.equal(printer.snapshot().zOffsetWizard?.active, true);
  } finally {
    await printer.finishZOffsetWizard();
    await printer.disconnect();
  }
});
