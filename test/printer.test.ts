import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { calculateESteps, Printer } from '../src/printer/printer.ts';

const printer = new Printer();

before(async () => {
  await printer.connect({ kind: 'mock' });
});

after(async () => {
  await printer.disconnect();
});

test('handshake fills firmware, capabilities and typed settings', () => {
  const s = printer.snapshot();
  assert.equal(s.connection.status, 'connected');
  assert.match(String(s.connection.firmware), /Marlin/);
  assert.equal(s.connection.machine, 'Kingroon KP5L');
  assert.equal(s.connection.capsReported, true);
  assert.equal(s.connection.caps['EEPROM'], true);
  assert.equal(s.connection.caps['EMERGENCY_PARSER'], false);
  assert.equal(s.persistence.dirty, false);
});

test('M503 is parsed into per-code numeric parameters', () => {
  const { settings } = printer.snapshot();
  assert.deepEqual(settings['M92'], { X: 160, Y: 160, Z: 800, E: 768 });
  assert.deepEqual(settings['M851'], { X: 27, Y: -6, Z: 0 });
  assert.equal(settings['M301']?.['P'], 24);
  assert.equal(settings['M900']?.['K'], 0.22);
  assert.ok(settings['M205'], 'M205 should be present');
});

test('warnings surface firmware gaps that matter for this app', () => {
  const { warnings } = printer.snapshot();
  assert.ok(
    warnings.some((w) => /EMERGENCY_PARSER/.test(w)),
    'must warn when the emergency parser is compiled out',
  );
  assert.ok(!warnings.some((w) => /EEPROM is disabled/.test(w)));
});

test('temperature reports stream into history', async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const s = printer.snapshot();
  assert.ok(s.temps.hotend.current > 15, `hotend reads ${s.temps.hotend.current}`);
  assert.ok(printer.tempHistory.length >= 2, 'history should accumulate samples');
});

test('jog is refused before homing, then allowed', async () => {
  await assert.rejects(() => printer.jog('X', 10), /not homed/i);
  await printer.home('');
  await printer.jog('X', 25);
  assert.ok(Math.abs(printer.snapshot().position.x - 25) < 0.01);
});

test('cold extrude is refused', async () => {
  await assert.rejects(() => printer.jog('E', 5), /at least 170/);
  await assert.rejects(() => printer.extrudeForESteps(100), /at least 170/);
});

test('E-steps calculation uses the measured filament distance', () => {
  assert.deepEqual(calculateESteps(768, 100, 96), {
    previous: 768,
    requested: 100,
    measured: 96,
    next: 800,
  });
  assert.throws(() => calculateESteps(768, 100, 0), /greater than 0/);
  assert.throws(() => calculateESteps(768, 100, 20), /more than 2×/);
});

test('hotend targets are clamped and gated on confirmation', async () => {
  await assert.rejects(() => printer.setHotendTarget(300), /exceeds limit/);
  await assert.rejects(() => printer.setHotendTarget(255), /needs explicit confirmation/);
  await printer.setHotendTarget(255, true);
  assert.equal(printer.snapshot().temps.hotend.target, 255);
  await printer.setHotendTarget(0);
});

test('bed targets are clamped', async () => {
  await assert.rejects(() => printer.setBedTarget(200), /exceeds limit/);
  await printer.setBedTarget(60);
  assert.equal(printer.snapshot().temps.bed.target, 60);
  await printer.setBedTarget(0);
});

test('automatic cooling acts only when M27 confirms the printer is idle', async () => {
  const idle = new Printer();
  const printing = new Printer();
  const unknown = new Printer();
  await Promise.all([
    idle.connect({ kind: 'mock', sdPrintStatus: 'idle' }),
    printing.connect({ kind: 'mock', sdPrintStatus: 'printing' }),
    unknown.connect({ kind: 'mock', sdPrintStatus: 'unknown' }),
  ]);

  try {
    await Promise.all([
      idle.setHotendTarget(200),
      idle.setBedTarget(60),
      printing.setHotendTarget(200),
      unknown.setHotendTarget(200),
    ]);

    const [idleDecision, printingDecision, unknownDecision] = await Promise.all([
      idle.coolIfIdle('test idle'),
      printing.coolIfIdle('test SD print'),
      unknown.coolIfIdle('test unknown status'),
    ]);

    assert.deepEqual(idleDecision, { action: 'cooled', sdPrintStatus: 'idle', reason: 'test idle' });
    assert.equal(idle.snapshot().temps.hotend.target, 0);
    assert.equal(idle.snapshot().temps.bed.target, 0);

    assert.equal(printingDecision.action, 'left_on');
    assert.equal(printingDecision.sdPrintStatus, 'printing');
    assert.equal(printing.snapshot().temps.hotend.target, 200);

    assert.equal(unknownDecision.action, 'left_on');
    assert.equal(unknownDecision.sdPrintStatus, 'unknown');
    assert.equal(unknown.snapshot().temps.hotend.target, 200);
  } finally {
    await Promise.all([idle.disconnect(), printing.disconnect(), unknown.disconnect()]);
  }
});

test('babystep rejects zero and oversized steps', async () => {
  await assert.rejects(() => printer.babystepZ(0), /at most 0.2/);
  await assert.rejects(() => printer.babystepZ(0.5), /at most 0.2/);
  await printer.babystepZ(-0.05);
});

test('probe offset validates and round-trips through M503', async () => {
  await assert.rejects(() => printer.setProbeOffset({}), /no probe offset/);
  await assert.rejects(() => printer.setProbeOffset({ z: 500 }), /out of range/);
  await printer.setProbeOffset({ z: -1.25 });
  assert.equal(printer.snapshot().settings['M851']?.['Z'], -1.25);
});

test('G29 mesh is captured without swallowing the column-header row', async () => {
  await printer.runBedLeveling(true);
  await new Promise((r) => setTimeout(r, 300));
  const { leveling } = printer.snapshot();
  assert.ok(leveling.mesh, 'mesh should be captured');
  assert.equal(leveling.mesh?.length, 4, 'a 4x4 probe must yield exactly 4 rows, not 5');
  for (const row of leveling.mesh ?? []) {
    assert.equal(row.length, 4);
    for (const v of row) assert.ok(Number.isFinite(v) && Math.abs(v) < 1);
  }
  assert.equal(leveling.on, true, 'Marlin enables compensation after G29');
  assert.equal(printer.snapshot().persistence.dirty, true, 'a new mesh must require M500');
});

test('raw terminal cannot bypass heater, motion or EEPROM safety paths', async () => {
  assert.throws(() => printer.gcode('M104 S250'), /сыром терминале/);
  assert.throws(() => printer.gcode('G1 X100'), /сыром терминале/);
  assert.throws(() => printer.gcode('M500'), /сыром терминале/);
  assert.throws(() => printer.gcode('M115\nM104 S250'), /сыром терминале/);
  const diagnostic = await printer.gcode('M115');
  assert.equal(diagnostic.ok, true);
  await assert.rejects(() => printer.applySettings(['M92 E800', 'M104 S250']), /not allowed/);
  await assert.rejects(() => printer.applySettings(['M92 E800\nM104 S250']), /not allowed/);
});

test('endstops are merged from the multi-line M119 report', async () => {
  await printer.readEndstops();
  await new Promise((r) => setTimeout(r, 200));
  const { endstops } = printer.snapshot();
  assert.ok(Object.keys(endstops).length >= 3, JSON.stringify(endstops));
  assert.equal(endstops['x_min'], 'open');
  assert.ok('z_probe' in endstops);
});

test('M500 is rate limited to protect the flash-emulated EEPROM', async () => {
  const first = await printer.saveToEeprom();
  assert.equal(first.ok, true);
  assert.equal(first.verified, true, first.mismatches.join('; '));
  assert.deepEqual(first.mismatches, []);
  assert.equal(printer.snapshot().eepromSaves, 1);
  assert.equal(printer.snapshot().persistence.dirty, false);
  assert.equal(printer.snapshot().persistence.verified, true);
  await assert.rejects(() => printer.saveToEeprom(), /erase budget/);
});

test('applying a batch of settings updates them in one refresh', async () => {
  await printer.applySettings(['M92 E770', 'M900 K0.05']);
  const { settings } = printer.snapshot();
  assert.equal(settings['M92']?.['E'], 770);
  assert.equal(settings['M900']?.['K'], 0.05);
  assert.equal(printer.snapshot().persistence.dirty, true);
});

test('E-steps calibration applies M92 without saving EEPROM', async () => {
  await printer.applySettings(['M92 E770']);
  const savesBefore = printer.snapshot().eepromSaves;
  const result = await printer.calibrateESteps(100, 96.25);
  assert.equal(result.previous, 770);
  assert.equal(result.next, 800);
  assert.equal(printer.snapshot().settings['M92']?.['E'], 800);
  assert.equal(printer.snapshot().eepromSaves, savesBefore);
});

test('bed PID is refused and warned about when the firmware has PIDTEMPBED off', async () => {
  const bangbang = new Printer();
  await bangbang.connect({ kind: 'mock', noBedPid: true });
  try {
    const s = bangbang.snapshot();
    assert.equal(s.settings['M304'], undefined, 'M503 must not report M304 on a bang-bang bed');
    assert.ok(
      s.warnings.some((w) => /bed runs bang-bang/.test(w)),
      'the user must be told the bed cannot be PID-tuned',
    );
    await assert.rejects(
      () => bangbang.pidAutotune({ target: 'bed', temp: 60, cycles: 3, apply: false }),
      /PIDTEMPBED disabled/,
    );
  } finally {
    await bangbang.disconnect();
  }
});

test('PID autotune returns parsed Kp/Ki/Kd lines and applies them', async () => {
  const res = await printer.pidAutotune({ target: 'hotend', temp: 205, cycles: 3, apply: true });
  assert.equal(res.ok, true, res.error);
  assert.ok(res.lines.some((l) => /^Kp:/.test(l)), 'autotune must report final constants');
  await printer.refreshSettings();
  assert.notEqual(printer.snapshot().settings['M301']?.['P'], 24);
});

test('handshake survives a noisy link and still learns the firmware', async () => {
  const noisy = new Printer();
  await noisy.connect({ kind: 'mock', chaos: true });
  try {
    const s = noisy.snapshot();
    assert.equal(s.connection.status, 'connected');
    assert.ok(
      s.connection.firmware !== null || s.connection.capsReported,
      'the M115 retry loop must recover firmware info even when lines get mangled',
    );
    assert.ok(Object.keys(s.settings).length > 0, 'the M503 retry loop must recover settings');
  } finally {
    await noisy.disconnect();
  }
});

test('unexpected transport loss reconnects and repeats the full handshake', async () => {
  const reconnecting = new Printer();
  await reconnecting.connect({ kind: 'mock' });
  await reconnecting.home('X');
  assert.equal(reconnecting.snapshot().homed.x, true);

  await reconnecting.simulateTransportLoss();
  assert.equal(reconnecting.snapshot().connection.status, 'error');

  const deadline = Date.now() + 4_000;
  while (reconnecting.snapshot().connection.status !== 'connected' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const restored = reconnecting.snapshot();
  assert.equal(restored.connection.status, 'connected');
  assert.equal(restored.homed.x, false, 'reconnect must not retain trusted home state');
  assert.ok(restored.settings['M92'], 'full M503 handshake must run after reconnect');
  await reconnecting.disconnect();
});

test('board reset inside a live USB session clears home trust and repeats the handshake', async () => {
  const resetting = new Printer();
  await resetting.connect({ kind: 'mock' });
  await resetting.home('X');
  assert.equal(resetting.snapshot().homed.x, true);

  resetting.simulateBoardReset();
  const deadline = Date.now() + 2_000;
  while (resetting.snapshot().connection.status !== 'connected' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const restored = resetting.snapshot();
  assert.equal(restored.connection.status, 'connected');
  assert.equal(restored.homed.x, false);
  assert.ok(restored.settings['M92'], 'M503 must be reread after the board reset');
  assert.ok(resetting.log.some((entry) => /state restored after board reset/.test(entry.text)));
  await resetting.disconnect();
});

test('E-Stop tells the user when there is no link instead of silently doing nothing', async () => {
  const offline = new Printer();
  assert.throws(() => offline.estop(), /выключи питание вручную/);
});

test('limit overrides are honoured but capped at hardware-plausible values', () => {
  const tight = new Printer({ hotendMax: 240, bedMax: 90 });
  assert.equal(tight.limits.hotendMax, 240);
  assert.equal(tight.limits.bedMax, 90);
  assert.equal(tight.limits.bedSize.x, 300);

  const absurd = new Printer({ hotendMax: 900, bedMax: 900 });
  assert.equal(absurd.limits.hotendMax, 300);
  assert.equal(absurd.limits.bedMax, 150);
});
