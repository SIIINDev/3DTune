import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, networkInterfaces, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* A first run fails for boring reasons: wrong Node, missing dependencies, an occupied port, a
 * firewall, no cable. Each has a different fix, so each gets checked separately and named. The point
 * is to answer "why doesn't it work" before the user has to guess.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';

export type Check = {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
};

const MIN_NODE = 24;

function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

export function lanAddresses(): { address: string; likely: boolean }[] {
  const out: { address: string; likely: boolean }[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      out.push({
        address: iface.address,
        likely: /^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(iface.address),
      });
    }
  }
  return out.sort((a, b) => Number(b.likely) - Number(a.likely));
}

export async function runDoctor(port: number): Promise<Check[]> {
  const checks: Check[] = [];
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');

  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  checks.push(
    major >= MIN_NODE
      ? { name: 'Node.js', status: 'ok', detail: `${process.versions.node}` }
      : {
          name: 'Node.js',
          status: 'fail',
          detail: `${process.versions.node} — нужна ${MIN_NODE} или новее`,
          fix: 'Установи текущий LTS с nodejs.org и запусти снова. 3DTune исполняет TypeScript напрямую, для этого нужен свежий Node.',
        },
  );

  const modules = join(root, 'node_modules');
  if (!existsSync(modules)) {
    checks.push({
      name: 'Зависимости',
      status: 'fail',
      detail: 'node_modules отсутствует',
      fix: 'Выполни в папке проекта: npm ci  (или npm install)',
    });
  } else {
    let serialOk = false;
    let serialError = '';
    try {
      await import('serialport');
      serialOk = true;
    } catch (err) {
      serialError = err instanceof Error ? err.message : String(err);
    }
    checks.push(
      serialOk
        ? { name: 'Зависимости', status: 'ok', detail: 'serialport загружается' }
        : {
            name: 'Зависимости',
            status: 'fail',
            detail: `serialport не загружается: ${serialError}`,
            fix: 'Удали node_modules и выполни npm ci заново. Нативный модуль собирается под конкретную версию Node.',
          },
    );
  }

  for (const asset of ['web/index.html', 'web/app.js', 'web/style.css', 'web/chart.js', 'web/mesh3d.js']) {
    if (!existsSync(join(root, asset))) {
      checks.push({
        name: 'Файлы интерфейса',
        status: 'fail',
        detail: `нет ${asset}`,
        fix: 'Скачай проект целиком — интерфейс раздаётся из папки web/.',
      });
    }
  }
  if (!checks.some((c) => c.name === 'Файлы интерфейса')) {
    checks.push({ name: 'Файлы интерфейса', status: 'ok', detail: 'все модули на месте' });
  }

  const configPath = join(homedir(), '.3dtune', 'config.json');
  if (!existsSync(configPath)) {
    checks.push({
      name: 'Конфигурация',
      status: 'ok',
      detail: 'файла ещё нет — будет создан при первом запуске вместе с токеном',
    });
  } else {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      const mode = statSync(configPath).mode & 0o777;
      const hasToken = typeof raw['token'] === 'string' && (raw['token'] as string).length >= 16;
      checks.push({
        name: 'Конфигурация',
        status: hasToken ? 'ok' : 'warn',
        detail: hasToken
          ? `токен на месте, права ${mode.toString(8)}`
          : 'токен отсутствует или слишком короткий — будет перевыпущен',
      });
    } catch (err) {
      checks.push({
        name: 'Конфигурация',
        status: 'warn',
        detail: `файл повреждён: ${err instanceof Error ? err.message : String(err)}`,
        fix: 'Ничего делать не нужно: 3DTune пересоздаст его и предупредит.',
      });
    }
  }

  const free = await portFree(port, '0.0.0.0');
  checks.push(
    free
      ? { name: `Порт ${port}`, status: 'ok', detail: 'свободен' }
      : {
          name: `Порт ${port}`,
          status: 'fail',
          detail: 'уже занят',
          fix: `Закрой другой экземпляр 3DTune или запусти с другим портом: --port ${port + 1}`,
        },
  );

  let ports: { path: string; likelyPrinter: boolean; manufacturer?: string }[] = [];
  try {
    const { listPorts } = await import('./transport/serial.ts');
    ports = await listPorts();
  } catch {
    ports = [];
  }
  const likely = ports.filter((p) => p.likelyPrinter);
  if (ports.length === 0) {
    checks.push({
      name: 'Последовательные порты',
      status: 'warn',
      detail: 'ни одного порта не найдено',
      fix:
        platform() === 'win32'
          ? 'Подключи принтер кабелем и включи его. Если Windows не видит устройство — поставь драйвер CH340 от WCH.'
          : 'Подключи принтер кабелем и включи его. На macOS может понадобиться драйвер CH340 (WCHSoftGroup/ch34xser_macos).',
    });
  } else {
    checks.push({
      name: 'Последовательные порты',
      status: likely.length > 0 ? 'ok' : 'warn',
      detail:
        likely.length > 0
          ? `похоже на принтер: ${likely.map((p) => p.path).join(', ')}`
          : `найдено ${ports.length}, но ни один не похож на принтер: ${ports.map((p) => p.path).join(', ')}`,
      fix: likely.length > 0 ? undefined : 'Проверь, что это тот кабель и что принтер включён.',
    });
  }

  const lan = lanAddresses();
  checks.push(
    lan.length > 0
      ? {
          name: 'Локальная сеть',
          status: 'ok',
          detail: lan.map((a) => `${a.address}${a.likely ? '' : ' (возможно, виртуальный адаптер)'}`).join(', '),
        }
      : {
          name: 'Локальная сеть',
          status: 'warn',
          detail: 'внешних IPv4-адресов нет — управление с других устройств не заработает',
          fix: 'Подключи компьютер к Wi-Fi или кабелем к тому же роутеру, что и телефон.',
        },
  );

  if (platform() === 'win32') {
    checks.push({
      name: 'Брандмауэр Windows',
      status: 'warn',
      detail: 'проверить автоматически нельзя',
      fix:
        'При первом запуске Windows спросит про доступ для Node.js — разреши для «Частных сетей». ' +
        'Если окно не появилось и с телефона не открывается, разреши вручную: ' +
        'Защитник Windows → Брандмауэр → Разрешить работу с приложением → Node.js → Частная сеть.',
    });
  }

  return checks;
}

export function formatDoctor(checks: Check[]): string {
  const icon: Record<CheckStatus, string> = { ok: 'OK  ', warn: '!   ', fail: 'СБОЙ' };
  const lines = ['3DTune — проверка готовности к первому запуску', ''];
  for (const check of checks) {
    lines.push(`${icon[check.status]} ${check.name}: ${check.detail}`);
    if (check.fix) lines.push(`       → ${check.fix}`);
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  lines.push('');
  lines.push(
    failed > 0
      ? `Запускать пока нельзя: ${failed} блокирующих пункт(ов). Исправь их и запусти проверку снова.`
      : warned > 0
        ? `Запускать можно. ${warned} пункт(ов) требуют внимания — они не блокируют, но могут помешать доступу с других устройств.`
        : 'Всё готово. Можно запускать.',
  );
  return `${lines.join('\n')}\n`;
}
