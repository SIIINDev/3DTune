import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Printer } from '../src/printer/printer.ts';

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
  await printer.gcode('G29');
  await new Promise((r) => setTimeout(r, 300));
  const { leveling } = printer.snapshot();
  assert.ok(leveling.mesh, 'mesh should be captured');
  assert.equal(leveling.mesh?.length, 4, 'a 4x4 probe must yield exactly 4 rows, not 5');
  for (const row of leveling.mesh ?? []) {
    assert.equal(row.length, 4);
    for (const v of row) assert.ok(Number.isFinite(v) && Math.abs(v) < 1);
  }
  assert.equal(leveling.on, true, 'Marlin enables compensation after G29');
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
  assert.equal(printer.snapshot().eepromSaves, 1);
  await assert.rejects(() => printer.saveToEeprom(), /erase budget/);
});

test('applying a batch of settings updates them in one refresh', async () => {
  await printer.applySettings(['M92 E770', 'M900 K0.05']);
  const { settings } = printer.snapshot();
  assert.equal(settings['M92']?.['E'], 770);
  assert.equal(settings['M900']?.['K'], 0.05);
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
