import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeStartGcode,
  curaMachineSettings,
  recommendedStartBlock,
  type StartGcodeFinding,
} from '../src/printer/slicer.ts';
import { KP5L_LIMITS } from '../src/printer/limits.ts';

const ctx = { limits: KP5L_LIMITS };

function codes(findings: StartGcodeFinding[]): string[] {
  return findings.map((f) => f.code);
}

function pick(findings: StartGcodeFinding[], code: string): StartGcodeFinding {
  const found = findings.find((f) => f.code === code);
  assert.ok(found, `expected a "${code}" finding, got: ${codes(findings).join(', ')}`);
  return found;
}

test('a clean start block produces no critical or warning findings', () => {
  const block = [
    'M140 S60',
    'M190 S60',
    'G28',
    'M104 S205',
    'M109 S205',
    'G1 X5 Y5 Z0.3 F3000',
    'G1 X200 E15 F1200',
  ].join('\n');
  const result = analyzeStartGcode(block, ctx);
  assert.equal(result.findings.filter((f) => f.severity !== 'info').length, 0);
  assert.equal(result.temperatures.hotend, 205);
  assert.equal(result.temperatures.bed, 60);
  assert.equal(result.material?.id, 'pla');
});

test('calibration commands are a warning alone and critical when the block saves them', () => {
  const session = analyzeStartGcode('G28\nM92 E93\nM851 Z-1.2', ctx);
  const overwrites = session.findings.filter((f) => f.code === 'overwrites_calibration');
  assert.equal(overwrites.length, 2);
  assert.ok(overwrites.every((f) => f.severity === 'warning'));

  const saved = analyzeStartGcode('G28\nM92 E93\nM851 Z-1.2\nM500', ctx);
  const permanent = saved.findings.filter((f) => f.code === 'overwrites_calibration');
  assert.equal(permanent.length, 2);
  assert.ok(permanent.every((f) => f.severity === 'critical'));
  assert.equal(pick(saved.findings, 'writes_eeprom').severity, 'critical');
});

test('an M500 above a calibration command does not make it permanent', () => {
  const result = analyzeStartGcode('M500\nM92 E93', ctx);
  assert.equal(pick(result.findings, 'overwrites_calibration').severity, 'warning');
});

test('M502 is reported as a factory reset', () => {
  const result = analyzeStartGcode('M502\nM500\nG28', ctx);
  const reset = pick(result.findings, 'factory_reset');
  assert.equal(reset.severity, 'critical');
  assert.match(reset.detail, /EEPROM/);
});

test('commented-out commands are not findings', () => {
  const result = analyzeStartGcode('G28 ; home\n; M500 was here\nM104 S205 ; heat', ctx);
  assert.equal(codes(result.findings).includes('writes_eeprom'), false);
  assert.equal(result.temperatures.hotend, 205);
});

test('the named symptom is caught: PLA preset selected, PETG temperatures in the file', () => {
  const block = 'M140 S80\nM190 S80\nG28\nM109 S240';
  const result = analyzeStartGcode(block, { ...ctx, presetId: 'pla' });
  assert.equal(result.material?.id, 'petg');
  const mismatch = pick(result.findings, 'material_mismatch');
  assert.equal(mismatch.severity, 'warning');
  assert.match(mismatch.title, /PLA/);
  assert.match(mismatch.title, /PETG/);
});

test('a matching preset produces no mismatch warning', () => {
  const result = analyzeStartGcode('M190 S60\nG28\nM109 S205', { ...ctx, presetId: 'pla' });
  assert.equal(codes(result.findings).includes('material_mismatch'), false);
  assert.equal(pick(result.findings, 'material_guess').severity, 'info');
});

test('temperatures above the host operating cap are critical', () => {
  const result = analyzeStartGcode('M109 S280\nM190 S130', ctx);
  const over = result.findings.filter((f) => f.code === 'temperature_over_limit');
  assert.equal(over.length, 2);
  assert.ok(over.every((f) => f.severity === 'critical'));
  assert.match(over[0]?.title ?? '', /265|110/);
});

test('slicer placeholders are recognised instead of parsed as numbers', () => {
  const result = analyzeStartGcode('M104 S{material_print_temperature_layer_0}\nM190 S[first_layer_bed_temperature]', ctx);
  assert.equal(result.temperatures.hotend, undefined);
  assert.equal(result.temperatures.bed, undefined);
  assert.equal(result.temperatures.placeholders, true);
  assert.equal(pick(result.findings, 'placeholders').severity, 'info');
  assert.equal(result.material, null);
});

test('movement limits are compared against the M503 report when it is available', () => {
  const settings = { M203: { X: 500, Y: 500, Z: 10, E: 25 }, M201: { X: 500, Y: 500, Z: 100, E: 5000 } };
  const result = analyzeStartGcode('M203 X800 Y400\nM201 X500', { ...ctx, settings });
  assert.equal(result.firmwareLimitsKnown, true);
  const over = result.findings.filter((f) => f.code === 'above_firmware_limit');
  assert.equal(over.length, 1);
  assert.match(over[0]?.detail ?? '', /X: 800 > 500/);
  assert.equal((over[0]?.detail ?? '').includes('Y'), false);
});

test('without an M503 read the limit check reports itself unavailable rather than guessing', () => {
  const result = analyzeStartGcode('M203 X800', ctx);
  assert.equal(result.firmwareLimitsKnown, false);
  assert.equal(pick(result.findings, 'limits_unknown').severity, 'info');
  assert.equal(codes(result.findings).includes('above_firmware_limit'), false);
});

test('M205 minimum-feedrate fields are not treated as exceeded maxima', () => {
  const settings = { M205: { X: 8, Y: 8, Z: 0.4, E: 5, J: 0.08, S: 0, T: 0, B: 20000 } };
  const result = analyzeStartGcode('M205 X10 S30 T40 B25000', { ...ctx, settings });
  const over = pick(result.findings, 'above_firmware_limit');
  assert.match(over.detail, /X: 10 > 8/);
  assert.equal(over.detail.includes('S:'), false);
  assert.equal(over.detail.includes('B:'), false);
});

/* The community KP5L build has ENABLE_LEVELING_AFTER_G28 on, so "just add M420 S1" — the standard
   internet answer — is wrong here. The advice text must stay gated on that fact. */
test('leveling advice states the firmware fact instead of blanket-recommending M420 S1', () => {
  const probing = analyzeStartGcode('G28\nG29', ctx);
  const wear = pick(probing.findings, 'probe_every_print');
  assert.equal(wear.severity, 'warning');
  assert.match(wear.fix ?? '', /ENABLE_LEVELING_AFTER_G28/);
  assert.match(wear.fix ?? '', /стоков/i);

  const enabling = analyzeStartGcode('G28\nM420 S1', ctx);
  const note = pick(enabling.findings, 'leveling_enable');
  assert.equal(note.severity, 'info');
  assert.match(note.detail, /ENABLE_LEVELING_AFTER_G28/);
});

/* G29 L<slot> loads a stored mesh on the community UBL build (reference/kp5l-marlin-2.1.1-abl),
   but on a BILINEAR or MBL build Marlin ignores the unknown argument and probes the whole bed.
   The analyzer must not silently pick one of those readings. */
test('a parameterised G29 is explained rather than judged, because the algorithm is compile-time', () => {
  const result = analyzeStartGcode('G28\nG29 L1', ctx);
  assert.equal(codes(result.findings).includes('probe_every_print'), false);
  const note = pick(result.findings, 'probe_parameterised');
  assert.equal(note.severity, 'info');
  assert.match(note.detail, /UBL/);
  assert.match(note.detail, /BILINEAR/);
});

test('probing before homing is critical', () => {
  const result = analyzeStartGcode('G29\nG28', ctx);
  const finding = pick(result.findings, 'probe_without_home');
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.line, 1);
});

test('extruding before M109 is flagged, and M104 alone does not count as waiting', () => {
  const result = analyzeStartGcode('G28\nM104 S205\nG1 X100 E10 F1200\nM109 S205', ctx);
  const cold = pick(result.findings, 'cold_extrude');
  assert.equal(cold.severity, 'warning');
  assert.equal(cold.line, 3);
});

test('a negative E move before heating is a retract, not a cold extrude', () => {
  const result = analyzeStartGcode('G28\nG1 E-2 F1800\nM109 S205', ctx);
  assert.equal(codes(result.findings).includes('cold_extrude'), false);
});

test('heating the hotend before the bed is reported as oozing', () => {
  const result = analyzeStartGcode('M109 S205\nM190 S60\nG28', ctx);
  assert.equal(pick(result.findings, 'heat_order').severity, 'info');
  assert.equal(codes(analyzeStartGcode('M190 S60\nM109 S205\nG28', ctx).findings).includes('heat_order'), false);
});

test('a start block that moves without homing is flagged', () => {
  const result = analyzeStartGcode('M109 S205\nG1 X100 F3000', ctx);
  assert.equal(pick(result.findings, 'no_home').severity, 'warning');
  assert.equal(codes(analyzeStartGcode('M104 S205', ctx).findings).includes('no_home'), false);
});

test('an end block is not accused of failing to home — it cools down, it does not heat', () => {
  const end = ['M104 S0', 'M140 S0', 'G91', 'G1 E-5 F1800', 'G1 Z10 F600', 'G90', 'G1 X0 Y300 F3000', 'M84'].join('\n');
  const result = analyzeStartGcode(end, ctx);
  assert.equal(codes(result.findings).includes('no_home'), false);
  assert.equal(codes(result.findings).includes('cold_extrude'), false);
  assert.equal(result.findings.filter((f) => f.severity !== 'info').length, 0);
});

test('an end block that overwrites calibration is still caught', () => {
  const result = analyzeStartGcode('M104 S0\nM851 Z-1.9\nM500\nM84', ctx);
  assert.equal(pick(result.findings, 'overwrites_calibration').severity, 'critical');
  assert.equal(codes(result.findings).includes('no_home'), false);
});

test('probing without homing does not also raise the redundant no_home warning', () => {
  const result = analyzeStartGcode('M109 S205\nG29\nG1 X10 F3000', ctx);
  assert.equal(pick(result.findings, 'probe_without_home').severity, 'critical');
  assert.equal(codes(result.findings).includes('no_home'), false);
});

test('driver current commands are useless on standalone TMC2225 and say so', () => {
  const result = analyzeStartGcode('M906 X800 Y800', ctx);
  const finding = pick(result.findings, 'driver_current');
  assert.equal(finding.severity, 'warning');
  assert.match(finding.detail, /standalone/);
});

test('findings come back worst-first', () => {
  const result = analyzeStartGcode('M104 S205\nM92 E93\nM502\nG28', ctx);
  const ranks = result.findings.map((f) => ({ critical: 0, warning: 1, info: 2 })[f.severity]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test('an empty block analyses cleanly', () => {
  const result = analyzeStartGcode('', ctx);
  assert.equal(result.commandCount, 0);
  assert.equal(result.findings.length, 0);
  assert.equal(result.material, null);
});

test('a real Cura start block for KP5L is parsed end to end', () => {
  const block = [
    ';FLAVOR:Marlin',
    'M140 S80',
    'M105',
    'M190 S80',
    'M104 S240',
    'M105',
    'M109 S240',
    'M82 ;absolute extrusion mode',
    'G21 ;metric values',
    'G90 ;absolute positioning',
    'M107 ;start with the fan off',
    'G28 ;Home',
    'G29 ;auto bed levelling',
    'M420 S1 ;enable mesh',
    'G92 E0 ;zero the extruder',
    'G1 Z2.0 F3000',
    'G1 X10.1 Y20 Z0.28 F5000.0',
    'G1 X10.1 Y200.0 Z0.28 F1500.0 E15',
    'G92 E0',
  ].join('\n');
  const result = analyzeStartGcode(block, { ...ctx, presetId: 'pla' });

  assert.equal(result.commandCount, 18);
  assert.equal(result.temperatures.hotend, 240);
  assert.equal(result.temperatures.bed, 80);
  assert.equal(result.material?.id, 'petg');

  const found = codes(result.findings);
  assert.ok(found.includes('material_mismatch'));
  assert.ok(found.includes('probe_every_print'));
  assert.ok(found.includes('leveling_enable'));
  assert.equal(found.includes('cold_extrude'), false);
  assert.equal(found.includes('overwrites_calibration'), false);
  assert.equal(result.findings.some((f) => f.severity === 'critical'), false);
});

/* ---------- what to hand back to the slicer ---------- */

test('the Cura export carries firmware values and labels what is only an assumption', () => {
  const settings = {
    M203: { X: 500, Y: 500, Z: 10, E: 25 },
    M201: { X: 500, Y: 500, Z: 100, E: 5000 },
    M204: { P: 500, R: 1000, T: 500 },
    M205: { B: 20000, S: 0, T: 0, X: 8, Y: 8, Z: 0.4, E: 5, J: 0 },
  };
  const { rows, missing } = curaMachineSettings({ limits: KP5L_LIMITS, settings });
  assert.deepEqual(missing, []);

  const byField = new Map(rows.map((r) => [r.field, r]));
  assert.equal(byField.get('X (width)')?.value, '300');
  assert.equal(byField.get('Z (height)')?.value, '330');
  assert.equal(byField.get('Maximum speed X')?.value, '500');
  assert.equal(byField.get('Maximum speed X')?.source, 'M503');
  assert.equal(byField.get('Print acceleration')?.value, '500');
  assert.equal(byField.get('Travel acceleration')?.value, '500');

  // Nozzle diameter is nowhere in the firmware, and the row has to admit it.
  assert.equal(byField.get('Nozzle size')?.source, 'assumption');
});

/* Marlin runs classic jerk or junction deviation, never both. Handing Cura a jerk the firmware
   ignores would make the slicer plan corners the printer does not take. */
test('the export reports junction deviation instead of jerk when the firmware uses it', () => {
  const withJd = curaMachineSettings({
    limits: KP5L_LIMITS,
    settings: { M205: { X: 8, Y: 8, Z: 0.4, E: 5, J: 0.08 } },
  });
  const fields = withJd.rows.map((r) => r.field);
  assert.ok(fields.includes('Junction deviation'));
  assert.equal(fields.includes('Maximum X jerk'), false);

  const withJerk = curaMachineSettings({
    limits: KP5L_LIMITS,
    settings: { M205: { X: 8, Y: 8, Z: 0.4, E: 5, J: 0 } },
  });
  assert.ok(withJerk.rows.map((r) => r.field).includes('Maximum X jerk'));
});

test('an unread M503 is listed as missing, not filled with defaults', () => {
  const { rows, missing } = curaMachineSettings({ limits: KP5L_LIMITS });
  assert.ok(missing.length > 0);
  assert.ok(missing.some((m) => m.includes('M203')));
  assert.equal(rows.some((r) => r.source === 'M503'), false);
  // The geometry rows do not depend on M503 and must still be there.
  assert.ok(rows.some((r) => r.field === 'X (width)'));
});

test('the generated start block carries no material and no calibration commands', () => {
  const { start, end } = recommendedStartBlock({
    limits: KP5L_LIMITS,
    hasProbe: true,
    hasMesh: true,
    levelingOn: true,
  });
  const text = start.join('\n');

  // Temperatures stay as slicer placeholders — a hardcoded 205 here is the same bug in reverse.
  assert.match(text, /M109 S\{material_print_temperature_layer_0\}/);
  assert.match(text, /M190 S\{material_bed_temperature_layer_0\}/);
  assert.equal(/M10[49] S\d/.test(text), false);

  for (const forbidden of ['M92', 'M301', 'M304', 'M851', 'M500', 'M502']) {
    assert.equal(text.includes(forbidden), false, `${forbidden} must never appear in a start block`);
  }

  // Heat order: bed waits before the hotend does.
  assert.ok(start.findIndex((l) => l.startsWith('M190')) < start.findIndex((l) => l.startsWith('M109')));
  // Homing precedes any move.
  assert.ok(start.findIndex((l) => l.startsWith('G28')) < start.findIndex((l) => l.startsWith('G1')));

  assert.ok(end.join('\n').includes('M104 S0'));
});

test('the generated block adapts to what the printer actually has', () => {
  const withMesh = recommendedStartBlock({ limits: KP5L_LIMITS, hasProbe: true, hasMesh: true, levelingOn: true });
  assert.ok(withMesh.start.some((l) => l.startsWith('M420 S1')));
  assert.ok(withMesh.notes.some((n) => n.includes('ENABLE_LEVELING_AFTER_G28')));

  const noMesh = recommendedStartBlock({ limits: KP5L_LIMITS, hasProbe: true, hasMesh: false, levelingOn: false });
  assert.equal(noMesh.start.some((l) => l.startsWith('M420 S1')), false);

  const noProbe = recommendedStartBlock({ limits: KP5L_LIMITS, hasProbe: false, hasMesh: false, levelingOn: false });
  assert.equal(noProbe.start.some((l) => l.includes('M420')), false);
  assert.ok(noProbe.notes.some((n) => n.includes('зонде')));
});

/* The generator and the analyzer have to agree: a block 3DTune produces must survive the check
   3DTune performs on it, or one of the two is lying. */
test('a generated block passes the analyzer with nothing worse than info', () => {
  const { start, end } = recommendedStartBlock({
    limits: KP5L_LIMITS,
    hasProbe: true,
    hasMesh: true,
    levelingOn: true,
  });
  for (const block of [start, end]) {
    const result = analyzeStartGcode(block.join('\n'), ctx);
    const bad = result.findings.filter((f) => f.severity !== 'info');
    assert.deepEqual(bad.map((f) => f.code), [], `generated block must analyse clean: ${bad.map((f) => f.title).join('; ')}`);
  }
});
