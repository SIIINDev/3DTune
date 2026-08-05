import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

/* The portable bundle is what the owner actually runs, and its failure modes are silent: a missing
   production dependency or the wrong native binary only shows up on the target machine, where there
   is no toolchain to diagnose it. So the bundle gets built and inspected here. */

const ROOT = join(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;

/* Two bundles, because they answer different questions. The Windows one proves a cross-platform
   bundle can be assembled from this machine at all; only the host one can actually be executed,
   since a native addon built for another platform will not load — by design. */
const TARGET = 'win-x64';
const bundle = join(ROOT, 'dist', `3dtune-${version}-${TARGET}`);

const hostTarget =
  process.platform === 'win32'
    ? process.arch === 'arm64'
      ? 'win-arm64'
      : 'win-x64'
    : process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'darwin-arm64'
        : 'darwin-x64'
      : 'linux-x64';
const hostBundle = join(ROOT, 'dist', `3dtune-${version}-${hostTarget}`);

before(() => {
  execFileSync('node', ['scripts/build-portable.mjs', '--target', TARGET], { cwd: ROOT, stdio: 'pipe' });
  if (hostTarget !== TARGET) {
    execFileSync('node', ['scripts/build-portable.mjs', '--target', hostTarget], { cwd: ROOT, stdio: 'pipe' });
  }
});

after(() => {
  rmSync(bundle, { recursive: true, force: true });
  rmSync(hostBundle, { recursive: true, force: true });
});

test('the bundle carries everything needed to run with no build step', () => {
  for (const entry of ['bin/3dtune.mjs', 'src/index.ts', 'web/index.html', 'web/app.js', 'package.json']) {
    assert.ok(existsSync(join(bundle, entry)), `missing ${entry}`);
  }
  assert.ok(existsSync(join(bundle, 'Запустить-3DTune.bat')), 'the Windows launcher must ship');
  assert.ok(existsSync(join(bundle, 'ЧИТАЙ-МЕНЯ.txt')), 'first-run instructions must ship');
  assert.ok(existsSync(join(bundle, 'docs/PHASE0_DISCOVERY.md')), 'the hardware gate must travel with the app');
});

test('every production dependency is present and no dev dependency leaked', () => {
  const declared = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  for (const name of Object.keys(declared.dependencies)) {
    assert.ok(existsSync(join(bundle, 'node_modules', name)), `production dependency ${name} is missing`);
  }
  for (const name of Object.keys(declared.devDependencies)) {
    assert.ok(
      !existsSync(join(bundle, 'node_modules', name)),
      `dev dependency ${name} must not ship — it doubles the download for nothing`,
    );
  }
  // serialport pulls a tree; a partial copy fails only at runtime on the target machine.
  assert.ok(existsSync(join(bundle, 'node_modules/@serialport/bindings-cpp')));
  assert.ok(existsSync(join(bundle, 'node_modules/@serialport/stream')));
  assert.ok(existsSync(join(bundle, 'node_modules/debug')), 'a transitive dependency was dropped');
});

test('exactly the target native binary ships, and nothing else', () => {
  const prebuilds = join(bundle, 'node_modules/@serialport/bindings-cpp/prebuilds');
  const platforms = readdirSync(prebuilds);
  assert.deepEqual(platforms, ['win32-x64'], `expected only win32-x64, found ${platforms.join(', ')}`);
  const addon = readdirSync(join(prebuilds, 'win32-x64')).find((f) => f.endsWith('.node'));
  assert.ok(addon, 'the win32-x64 addon itself must be present, not just the folder');
  assert.ok(statSync(join(prebuilds, 'win32-x64', addon)).size > 10_000, 'the addon looks truncated');
});

test('the Windows launcher keeps CRLF, or cmd.exe cannot read it', () => {
  const raw = readFileSync(join(bundle, 'Запустить-3DTune.bat'));
  assert.ok(raw.includes(Buffer.from('\r\n')), 'the batch file lost its CRLF line endings');
  const text = raw.toString('utf8');
  assert.match(text, /--doctor/, 'the launcher must refuse to start on a broken environment');
  assert.match(text, /--host 0\.0\.0\.0/, 'the launcher must expose the LAN, that is the whole point');
});

test('the bundle stays small enough to send over a messenger', () => {
  const size = (dir: string): number =>
    readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
      const full = join(dir, entry.name);
      return total + (entry.isDirectory() ? size(full) : statSync(full).size);
    }, 0);
  const mb = size(bundle) / 1024 / 1024;
  assert.ok(mb < 25, `bundle without an embedded runtime grew to ${mb.toFixed(1)} MB`);
});

test('the built copy runs its own doctor rather than depending on the checkout', () => {
  const out = execFileSync('node', ['bin/3dtune.mjs', '--doctor', '--port', '18431'], {
    cwd: hostBundle,
    encoding: 'utf8',
  });
  assert.match(out, /Node\.js/);
  assert.match(out, /Зависимости: serialport загружается/, 'the copied native module must load from the bundle');
  assert.match(out, /Файлы интерфейса: все модули на месте/);
  assert.match(out, /Файлы интерфейса|Локальная сеть/);
});

test('a bundle unzipped on the wrong platform fails loudly instead of silently', () => {
  if (hostTarget === TARGET) return; // nothing to prove when the host IS the target

  let output = '';
  try {
    execFileSync('node', ['bin/3dtune.mjs', '--doctor', '--port', '18432'], {
      cwd: bundle,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.fail('a Windows bundle must not appear to work on a non-Windows host');
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  // The user needs to understand it is the wrong download, not a broken program.
  assert.match(output, /No native build was found|platform=/, `unhelpful failure: ${output.slice(0, 200)}`);
  assert.match(output, /3DTune/, 'the failure must be attributed to 3DTune, not an anonymous stack trace');
});
