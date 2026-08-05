import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMMISSIONING_STAGES,
  COMMISSIONING_STEPS,
  FILAMENT_PRESETS,
  presetById,
  stepById,
} from '../src/printer/commissioning.ts';
import { KP5L_LIMITS } from '../src/printer/limits.ts';
import { Printer } from '../src/printer/printer.ts';

test('the catalogue is internally consistent', () => {
  const ids = COMMISSIONING_STEPS.map((step) => step.id);
  assert.equal(new Set(ids).size, ids.length, 'step ids must be unique — the client selects by id');

  const stages = new Set(COMMISSIONING_STAGES.map((stage) => stage.stage));
  for (const step of COMMISSIONING_STEPS) {
    assert.ok(stages.has(step.stage), `${step.id} belongs to an undeclared stage`);
    assert.ok(step.why.length > 20, `${step.id} must say why it exists, or it gets skipped`);
    const actionable = step.gcode?.length || step.physical || step.useWizard || step.hostCannot;
    assert.ok(actionable, `${step.id} tells the user nothing to do`);
  }
});

test('mechanics come before anything that measures', () => {
  const order = COMMISSIONING_STAGES.map((stage) => stage.stage);
  assert.deepEqual(order, ['mechanics', 'sensors', 'thermal', 'extruder', 'bed', 'finalize']);

  const firstIndex = (stage: string) => COMMISSIONING_STEPS.findIndex((step) => step.stage === stage);
  assert.ok(firstIndex('mechanics') < firstIndex('sensors'));
  assert.ok(firstIndex('sensors') < firstIndex('thermal'), 'never PID-tune before checking the thermistor');
  assert.ok(firstIndex('thermal') < firstIndex('extruder'), 'E-steps needs a hot end that holds temperature');
  assert.ok(firstIndex('extruder') < firstIndex('bed'));
  assert.ok(firstIndex('bed') < firstIndex('finalize'));
});

test('every hazardous step demands confirmation, and harmless ones do not', () => {
  for (const step of COMMISSIONING_STEPS) {
    if (!step.gcode || step.gcode.length === 0) continue;
    const moves = step.gcode.some((c) => /^(G28|G1)\b/i.test(c));
    const heats = step.gcode.some((c) => /^(M104|M109|M140|M190)\b[ \t]+S(?!0\b)/i.test(c));
    if (moves || heats) {
      assert.equal(step.needsConfirm, true, `${step.id} moves or heats and must ask first`);
      assert.notEqual(step.hazard, 'none', `${step.id} must declare its hazard`);
    }
  }
  // Turning heat OFF must never be gated behind a dialog.
  const cooldown = stepById('therm-cooldown');
  assert.ok(cooldown?.gcode?.includes('M104 S0'));
  assert.notEqual(cooldown?.needsConfirm, true, 'cooling down must never require confirmation');
});

test('no catalogue command exceeds the machine limits', () => {
  for (const step of COMMISSIONING_STEPS) {
    for (const command of step.gcode ?? []) {
      const hotend = /^M10[49][ \t]+S(\d+)$/i.exec(command);
      if (hotend) {
        assert.ok(
          Number(hotend[1]) <= KP5L_LIMITS.hotendMax,
          `${step.id} asks for ${hotend[1]}C, above the ${KP5L_LIMITS.hotendMax}C limit`,
        );
      }
      const bed = /^M140[ \t]+S(\d+)$/i.exec(command);
      if (bed) {
        assert.ok(Number(bed[1]) <= KP5L_LIMITS.bedMax, `${step.id} asks for ${bed[1]}C on the bed`);
      }
    }
  }
});

test('no catalogue step extrudes: cold-extrude protection lives on another path', () => {
  for (const step of COMMISSIONING_STEPS) {
    for (const command of step.gcode ?? []) {
      assert.doesNotMatch(command, /^G1\b.*\bE/i, `${step.id} must not extrude through the step runner`);
    }
  }
});

test('steps that need the probe are marked, so they can be hidden without one', () => {
  const probeSteps = COMMISSIONING_STEPS.filter((step) => step.requiresProbe).map((step) => step.id);
  assert.ok(probeSteps.includes('sens-probe'));
  assert.ok(probeSteps.includes('sens-probe-trigger'));
  assert.ok(probeSteps.includes('bed-mesh'));
});

test('what the host genuinely cannot do is stated rather than faked', () => {
  const flow = stepById('extr-flow');
  assert.ok(flow?.hostCannot, 'flow calibration needs a printed test — that must be admitted');
  assert.equal(flow?.gcode, undefined, 'a step the host cannot do must not pretend to run commands');
});

test('filament presets stay inside the machine limits and carry slicer guidance', () => {
  assert.ok(FILAMENT_PRESETS.length >= 4);
  for (const preset of FILAMENT_PRESETS) {
    assert.ok(preset.hotend <= KP5L_LIMITS.hotendMax, `${preset.name} hotend ${preset.hotend}C is over the limit`);
    assert.ok(preset.firstLayerHotend <= KP5L_LIMITS.hotendMax);
    assert.ok(preset.bed <= KP5L_LIMITS.bedMax, `${preset.name} bed ${preset.bed}C is over the limit`);
    assert.ok(preset.firstLayerBed <= KP5L_LIMITS.bedMax);
    assert.ok(preset.fan >= 0 && preset.fan <= 100);
    assert.ok(preset.slicer.length > 20, `${preset.name} must say what belongs in the slicer`);
  }
  assert.equal(presetById('abs')?.fan, 0, 'ABS must not be cooled');
});

test('a step runs its prepared commands and reports each one', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock' });
  try {
    const run = await printer.runCommissioningStep('sens-part-fan', false);
    assert.equal(run.stepId, 'sens-part-fan');
    assert.deepEqual(
      run.commands.map((c) => c.command),
      ['M106 S255', 'M106 S128', 'M107'],
    );
    assert.ok(run.commands.every((c) => c.ok), JSON.stringify(run.commands));
  } finally {
    await printer.disconnect();
  }
});

test('a hazardous step is refused without confirmation and accepted with it', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock' });
  try {
    await assert.rejects(() => printer.runCommissioningStep('sens-axis-direction', false), /подтверждение/);
    const run = await printer.runCommissioningStep('sens-axis-direction', true);
    assert.ok(run.commands.every((c) => c.ok), JSON.stringify(run.commands));
  } finally {
    await printer.disconnect();
  }
});

test('a hands-only step and an unknown id are both rejected clearly', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock' });
  try {
    await assert.rejects(() => printer.runCommissioningStep('mech-belts', true), /выполняется руками/);
    await assert.rejects(() => printer.runCommissioningStep('nope', true), /неизвестный шаг/);
  } finally {
    await printer.disconnect();
  }
});

test('probe steps are refused when the firmware reports no probe', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock', caps: { Z_PROBE: false } });
  try {
    await assert.rejects(() => printer.runCommissioningStep('sens-probe', true), /поддержке зонда/);
  } finally {
    await printer.disconnect();
  }
});

test('applying a preset goes through the clamped setters, not raw G-code', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock' });
  try {
    const petg = await printer.applyFilamentPreset('petg', false);
    assert.equal(petg.name, 'PETG');
    const s = printer.snapshot();
    assert.equal(s.temps.hotend.target, 240);
    assert.equal(s.temps.bed.target, 80);
    assert.equal(s.fan, Math.round((40 / 100) * 255));

    const first = await printer.applyFilamentPreset('pla', true);
    assert.equal(printer.snapshot().temps.hotend.target, first.firstLayerHotend);

    await assert.rejects(() => printer.applyFilamentPreset('unobtanium', false), /неизвестный пресет/);
  } finally {
    await printer.setHotendTarget(0);
    await printer.setBedTarget(0);
    await printer.disconnect();
  }
});

test('probing progress is parsed from real Marlin phrasing and clears when done', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock' });
  try {
    assert.equal(printer.snapshot().probing, null, 'no probing state before any G29');

    const seen: { done: number; total: number | null }[] = [];
    printer.on('state', (s: { probing: { active: boolean; done: number; total: number | null } | null }) => {
      if (s.probing?.active) seen.push({ done: s.probing.done, total: s.probing.total });
    });

    await printer.runBedLeveling(true);

    assert.ok(seen.length >= 2, `expected progress updates, saw ${seen.length}`);
    const counted = seen.filter((p) => p.total !== null);
    assert.ok(counted.length >= 2, 'Marlin reports "Probing point N/M." and both numbers must land');
    assert.equal(counted.at(-1)?.total, 16, 'a 4x4 grid announces 16 points');
    assert.equal(counted.at(-1)?.done, 16, 'the final point must be reported');
    for (let i = 1; i < counted.length; i++) {
      assert.ok(counted[i]!.done >= counted[i - 1]!.done, 'progress must never go backwards');
    }

    assert.equal(printer.snapshot().probing?.active, false, 'probing must stop being active when G29 ends');
  } finally {
    await printer.disconnect();
  }
});
