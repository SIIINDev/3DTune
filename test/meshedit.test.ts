import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Printer } from '../src/printer/printer.ts';

/* Fade height and single-point mesh edits: the two Phase-3 promises that were still missing from
   the host. Both go through the printer rather than the raw terminal, so both are validated. */

async function connected(): Promise<Printer> {
  const printer = new Printer();
  await printer.connect({ kind: 'mock' });
  return printer;
}

test('fade height round-trips through M420 Z and is read back from M503', async () => {
  const printer = await connected();
  try {
    // The simulator starts at DEFAULT_LEVELING_FADE_HEIGHT from the community KP5L config.
    assert.equal(printer.snapshot().settings['M420']?.['Z'], 10);

    const result = await printer.setFadeHeight(4.5);
    assert.deepEqual(result, { requested: 4.5, reported: 4.5 });
    assert.equal(printer.snapshot().settings['M420']?.['Z'], 4.5);

    // 0 is a real value — compensate at every height — not "unset".
    assert.deepEqual(await printer.setFadeHeight(0), { requested: 0, reported: 0 });
  } finally {
    await printer.disconnect();
  }
});

test('fade height rejects negatives and anything above the Z travel', async () => {
  const printer = await connected();
  try {
    await assert.rejects(() => printer.setFadeHeight(-1), /bad_value|>= 0/);
    await assert.rejects(() => printer.setFadeHeight(printer.limits.bedSize.z + 1), /Z travel/);
  } finally {
    await printer.disconnect();
  }
});

test('a mesh point edit reaches the firmware and is re-read, not patched locally', async () => {
  const printer = await connected();
  try {
    await printer.runBedLeveling(true);
    const before = printer.snapshot().leveling.mesh;
    assert.ok(before && before.length > 0);

    const result = await printer.editMeshPoint(1, 2, 0.321);
    assert.equal(result.mesh?.[2]?.[1], 0.321);

    // The value must come back from the printer's own M420 V1 report, not from an optimistic
    // client-side write — so the snapshot has to agree with it.
    assert.equal(printer.snapshot().leveling.mesh?.[2]?.[1], 0.321);
  } finally {
    await printer.disconnect();
  }
});

test('a mesh point edit marks the printer as unsaved until M500', async () => {
  const printer = await connected();
  try {
    await printer.runBedLeveling(true);
    await printer.saveToEeprom();
    assert.equal(printer.snapshot().persistence.dirty, false);

    await printer.editMeshPoint(0, 0, -0.4);
    assert.equal(printer.snapshot().persistence.dirty, true);
  } finally {
    await printer.disconnect();
  }
});

test('editing a point outside the mesh, or with no mesh at all, is refused', async () => {
  const printer = await connected();
  try {
    await assert.rejects(() => printer.editMeshPoint(0, 0, 0), /no_mesh|сетки нет/);

    await printer.runBedLeveling(true);
    const mesh = printer.snapshot().leveling.mesh ?? [];
    const rows = mesh.length;
    const columns = mesh[0]?.length ?? 0;
    await assert.rejects(() => printer.editMeshPoint(columns, 0, 0), /вне сетки/);
    await assert.rejects(() => printer.editMeshPoint(0, rows, 0), /вне сетки/);
    await assert.rejects(() => printer.editMeshPoint(0.5, 0, 0), /вне сетки/);
  } finally {
    await printer.disconnect();
  }
});

test('a mesh Z far beyond any real bed shape is refused before it reaches the nozzle', async () => {
  const printer = await connected();
  try {
    await printer.runBedLeveling(true);
    await assert.rejects(() => printer.editMeshPoint(0, 0, 12), /±5/);
    await assert.rejects(() => printer.editMeshPoint(0, 0, Number.NaN), /±5/);
  } finally {
    await printer.disconnect();
  }
});
