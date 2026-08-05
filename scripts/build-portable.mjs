/* Builds a portable, self-contained folder that runs 3DTune without installing anything.
 *
 * There is deliberately no compiler step and no installer framework. 3DTune is a local server, so
 * the distributable is a directory: the app, its two production dependencies, and optionally a Node
 * runtime. Uninstalling is deleting the folder.
 *
 * The one thing that could have forced a Windows build machine — serialport's native addon — does
 * not: the npm package ships prebuilt binaries for every platform, so a Windows bundle can be
 * assembled from macOS or Linux. Everything else is plain text.
 *
 *   node scripts/build-portable.mjs                        # host platform, uses installed Node
 *   node scripts/build-portable.mjs --target win-x64       # Windows bundle, needs Node on the PC
 *   node scripts/build-portable.mjs --target win-x64 --with-node 24.9.0   # embeds the runtime
 *   node scripts/build-portable.mjs --target win-x64 --zip
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* Maps a distribution target onto the two names that matter: the folder serialport keeps its
   prebuilt addon in, and the archive Node publishes. Keeping them together stops a bundle from
   silently shipping the wrong binary. */
const TARGETS = {
  'win-x64': { prebuild: 'win32-x64', nodeArchive: 'win-x64', nodeExe: 'node.exe', kind: 'zip' },
  'win-arm64': { prebuild: 'win32-arm64', nodeArchive: 'win-arm64', nodeExe: 'node.exe', kind: 'zip' },
  'darwin-arm64': { prebuild: 'darwin-x64+arm64', nodeArchive: 'darwin-arm64', nodeExe: 'bin/node', kind: 'tar' },
  'darwin-x64': { prebuild: 'darwin-x64+arm64', nodeArchive: 'darwin-x64', nodeExe: 'bin/node', kind: 'tar' },
  'linux-x64': { prebuild: 'linux-x64', nodeArchive: 'linux-x64', nodeExe: 'bin/node', kind: 'tar' },
};

const APP_FILES = ['src', 'web', 'bin', 'docs', 'reference', 'package.json', 'package-lock.json', 'README.md'];
const LAUNCHERS = ['Запустить-3DTune.bat', 'Запустить-3DTune.command'];

function parseArgs(argv) {
  const args = { target: hostTarget(), withNode: null, zip: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') args.target = argv[++i];
    else if (argv[i] === '--with-node') args.withNode = argv[++i];
    else if (argv[i] === '--zip') args.zip = true;
    else if (argv[i] === '--help') args.help = true;
  }
  return args;
}

function hostTarget() {
  if (platform() === 'win32') return arch() === 'arm64' ? 'win-arm64' : 'win-x64';
  if (platform() === 'darwin') return arch() === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  return 'linux-x64';
}

function prodPackages() {
  // npm knows the exact production tree; deriving it by hand is how a bundle ends up missing a dep.
  const out = execFileSync('npm', ['ls', '--omit=dev', '--parseable', '--all'], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== ROOT)
    .map((line) => relative(ROOT, line))
    .filter((rel) => rel.startsWith('node_modules'));
}

function prunePrebuilds(bundleDir, keep) {
  const base = join(bundleDir, 'node_modules', '@serialport', 'bindings-cpp', 'prebuilds');
  if (!existsSync(base)) return 0;
  let removed = 0;
  for (const entry of readdirSync(base)) {
    if (entry === keep) continue;
    rmSync(join(base, entry), { recursive: true, force: true });
    removed++;
  }
  if (!existsSync(join(base, keep))) {
    throw new Error(`serialport has no prebuilt addon for ${keep}; the bundle would not be able to open a port`);
  }
  return removed;
}

function directorySize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else total += statSync(full).size;
  }
  return total;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function embedNode(bundleDir, target, version) {
  const spec = TARGETS[target];
  const name = `node-v${version}-${spec.nodeArchive}`;
  const url = `https://nodejs.org/dist/v${version}/${name}.${spec.kind === 'zip' ? 'zip' : 'tar.gz'}`;
  const work = join(tmpdir(), `3dtune-node-${version}-${spec.nodeArchive}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  process.stdout.write(`  скачиваю Node ${version} для ${spec.nodeArchive}…\n`);
  const archive = join(work, `node.${spec.kind === 'zip' ? 'zip' : 'tar.gz'}`);
  execFileSync('curl', ['-sSLf', '--max-time', '300', '-o', archive, url]);

  if (spec.kind === 'zip') execFileSync('unzip', ['-q', archive, '-d', work]);
  else execFileSync('tar', ['-xzf', archive, '-C', work]);

  const runtime = join(bundleDir, 'runtime');
  mkdirSync(runtime, { recursive: true });
  const source = join(work, name, spec.nodeExe);
  if (!existsSync(source)) throw new Error(`расчитывал найти ${spec.nodeExe} в архиве Node, но его там нет`);
  const destination = join(runtime, spec.nodeExe.includes('/') ? 'node' : spec.nodeExe);
  cpSync(source, destination);
  if (!spec.nodeExe.includes('/')) {
    // Windows: nothing else needed. Unix: keep the executable bit.
  } else {
    execFileSync('chmod', ['+x', destination]);
  }
  rmSync(work, { recursive: true, force: true });
  return destination;
}

function writeFirstRun(bundleDir, target, embedded) {
  const windows = target.startsWith('win');
  const launcher = windows ? 'Запустить-3DTune.bat' : 'Запустить-3DTune.command';
  const text = [
    '3DTune — управление и настройка Kingroon KP5L',
    '=============================================',
    '',
    `Сборка: ${target}${embedded ? ' (Node внутри, устанавливать ничего не нужно)' : ''}`,
    '',
    'КАК ЗАПУСТИТЬ',
    `  Двойной клик по «${launcher}».`,
    '',
    embedded
      ? '  Node.js уже внутри папки runtime — отдельно ставить не нужно.'
      : '  Нужен установленный Node.js 24 или новее: https://nodejs.org (LTS).',
    '',
    windows
      ? [
          'ПРИ ПЕРВОМ ЗАПУСКЕ',
          '  Windows спросит про доступ к сети для Node.js — разреши для ЧАСТНЫХ сетей.',
          '  Без этого телефон и мак не смогут подключиться.',
          '',
          '  Если принтер не появляется в списке портов — поставь драйвер CH340:',
          '  https://www.wch-ic.com/downloads/CH341SER_ZIP.html',
        ].join('\n')
      : [
          'ПРИ ПЕРВОМ ЗАПУСКЕ',
          '  macOS может спросить разрешение на приём входящих подключений — разреши.',
          '  Если принтер не появляется в списке портов, нужен драйвер CH340.',
        ].join('\n'),
    '',
    'УПРАВЛЕНИЕ С ТЕЛЕФОНА И ДРУГОГО КОМПЬЮТЕРА',
    '  В 3DTune: карточка «Подключить устройство» → «Показать код».',
    '  На другом устройстве открой показанный адрес и введи 6 цифр.',
    '',
    'ПРОВЕРКА БЕЗ ЗАПУСКА',
    `  ${embedded ? (windows ? 'runtime\\node.exe' : './runtime/node') : 'node'} bin/3dtune.mjs --doctor`,
    '',
    'ВАЖНО',
    '  Не выставляй это в интернет. Управление нагревателем на 250 °C наружу не выносится.',
    '  Перед первым нагревом и движением пройди docs/PHASE0_DISCOVERY.md.',
    '',
    'УДАЛЕНИЕ',
    '  Удалить эту папку. Настройки лежат в домашней папке: .3dtune',
    '',
  ].join('\n');
  writeFileSync(join(bundleDir, windows ? 'ЧИТАЙ-МЕНЯ.txt' : 'ЧИТАЙ-МЕНЯ.txt'), `${text}\n`);
}

function patchLaunchers(bundleDir, target, embedded) {
  if (!embedded) return;
  // Prefer the bundled runtime, but keep working if the folder is copied without it.
  const bat = join(bundleDir, 'Запустить-3DTune.bat');
  if (existsSync(bat)) {
    let text = readFileSync(bat, 'utf8');
    text = text.replace(
      'where node >nul 2>nul',
      'if exist "runtime\\node.exe" (set "NODEBIN=runtime\\node.exe") else (set "NODEBIN=node")\r\nwhere %NODEBIN% >nul 2>nul',
    );
    text = text.replaceAll('call node ', 'call %NODEBIN% ');
    text = text.replaceAll("node -p ", "%NODEBIN% -p ");
    writeFileSync(bat, text);
  }
  const cmd = join(bundleDir, 'Запустить-3DTune.command');
  if (existsSync(cmd)) {
    let text = readFileSync(cmd, 'utf8');
    text = text.replace(
      'if ! command -v node >/dev/null 2>&1; then',
      'if [ -x ./runtime/node ]; then NODEBIN=./runtime/node; else NODEBIN=node; fi\nif ! command -v "$NODEBIN" >/dev/null 2>&1 && [ ! -x "$NODEBIN" ]; then',
    );
    text = text.replaceAll('node -p ', '"$NODEBIN" -p ');
    text = text.replaceAll('node bin/3dtune.mjs', '"$NODEBIN" bin/3dtune.mjs');
    writeFileSync(cmd, text);
    execFileSync('chmod', ['+x', cmd]);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'node scripts/build-portable.mjs [--target win-x64|win-arm64|darwin-arm64|darwin-x64|linux-x64]\n' +
        '                               [--with-node <версия>] [--zip]\n',
    );
    return;
  }
  const spec = TARGETS[args.target];
  if (!spec) throw new Error(`неизвестная цель ${args.target}; доступны: ${Object.keys(TARGETS).join(', ')}`);

  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const bundleName = `3dtune-${version}-${args.target}`;
  const distDir = join(ROOT, 'dist');
  const bundleDir = join(distDir, bundleName);

  process.stdout.write(`Собираю ${bundleName}\n`);
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });

  for (const entry of APP_FILES) {
    const from = join(ROOT, entry);
    if (!existsSync(from)) throw new Error(`нет ${entry} — сборка была бы неполной`);
    cpSync(from, join(bundleDir, entry), { recursive: true });
  }
  for (const entry of LAUNCHERS) {
    const from = join(ROOT, entry);
    if (existsSync(from)) cpSync(from, join(bundleDir, entry));
  }

  const packages = prodPackages();
  for (const rel of packages) cpSync(join(ROOT, rel), join(bundleDir, rel), { recursive: true });
  process.stdout.write(`  зависимости: ${packages.length} пакет(ов)\n`);

  const removed = prunePrebuilds(bundleDir, spec.prebuild);
  process.stdout.write(`  нативный модуль: оставлен ${spec.prebuild}, удалено лишних платформ: ${removed}\n`);

  let embedded = false;
  if (args.withNode) {
    await embedNode(bundleDir, args.target, args.withNode);
    embedded = true;
    process.stdout.write('  Node вложен в runtime/\n');
  }

  writeFirstRun(bundleDir, args.target, embedded);
  patchLaunchers(bundleDir, args.target, embedded);

  process.stdout.write(`  размер: ${mb(directorySize(bundleDir))}\n`);

  if (args.zip) {
    const archive = join(distDir, `${bundleName}.zip`);
    rmSync(archive, { force: true });
    execFileSync('zip', ['-qr', archive, bundleName], { cwd: distDir });
    process.stdout.write(`  архив: dist/${bundleName}.zip (${mb(statSync(archive).size)})\n`);
  }

  process.stdout.write(`Готово: dist/${bundleName}\n`);
}

await main();
