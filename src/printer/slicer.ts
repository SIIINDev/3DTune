import { FILAMENT_PRESETS, type FilamentPreset } from './commissioning.ts';
import type { MachineLimits } from './limits.ts';

export type StartGcodeSeverity = 'critical' | 'warning' | 'info';

export type StartGcodeFinding = {
  code: string;
  severity: StartGcodeSeverity;
  /* 1-based line in the pasted block; 0 when the finding is about the block as a whole. */
  line: number;
  source: string;
  title: string;
  detail: string;
  fix?: string;
};

export type MaterialGuess = {
  id: string;
  name: string;
  hotend: number;
  bed: number;
  distance: number;
};

export type StartGcodeAnalysis = {
  lineCount: number;
  commandCount: number;
  temperatures: {
    hotend?: number;
    bed?: number;
    /* Cura/PrusaSlicer keep the start block as a template: the temperature is a placeholder until
       the file is sliced, so a missing number here is not the same as "no heating". */
    placeholders: boolean;
  };
  material: MaterialGuess | null;
  firmwareLimitsKnown: boolean;
  findings: StartGcodeFinding[];
};

export type StartGcodeContext = {
  limits: MachineLimits;
  /* Parsed M503 report, as Printer keeps it: { M203: { X: 500, ... }, ... }. */
  settings?: Record<string, Record<string, number>> | undefined;
  presetId?: string | undefined;
};

type Command = {
  line: number;
  source: string;
  code: string;
  params: Record<string, number>;
  placeholders: Set<string>;
};

const PLACEHOLDER = /\{[^}]*\}|\[[^\]]*\]/g;

/* M500 is what turns a session-only change into a permanent one, so the same M92/M851 is a
   different problem depending on whether the block saves afterwards. */
const CALIBRATION_COMMANDS: Record<string, string> = {
  M92: 'шаги на мм',
  M301: 'PID сопла',
  M304: 'PID стола',
  M851: 'Z-offset зонда',
  M206: 'home offset',
  M900: 'linear advance K',
};

/* M205 mixes maxima with minima: S/T are minimum feedrates and B is a minimum segment time, so
   "above the firmware value" only means something for the jerk/junction fields. */
const LIMIT_FIELDS: Record<string, string[]> = {
  M201: ['X', 'Y', 'Z', 'E'],
  M203: ['X', 'Y', 'Z', 'E'],
  M204: ['P', 'R', 'T'],
  M205: ['X', 'Y', 'Z', 'E', 'J'],
};

const LIMIT_TITLES: Record<string, string> = {
  M201: 'ускорения',
  M203: 'максимальные скорости',
  M204: 'ускорения печати/ретракта/холостого хода',
  M205: 'jerk / junction deviation',
};

export function analyzeStartGcode(text: string, ctx: StartGcodeContext): StartGcodeAnalysis {
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
  const commands = parseCommands(rawLines);
  const findings: StartGcodeFinding[] = [];

  const temps = collectTemperatures(commands);
  const material = guessFilament(temps.hotend, temps.bed);

  checkCalibrationWrites(commands, findings);
  checkTemperatureLimits(commands, ctx.limits, findings);
  checkMaterialMismatch(temps, material, ctx.presetId, findings);
  const firmwareLimitsKnown = checkFirmwareLimits(commands, ctx.settings, findings);
  checkLeveling(commands, findings);
  checkHomingAndExtrusion(commands, findings);
  checkDriverCurrent(commands, findings);
  checkPlaceholders(temps, findings);

  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.line - b.line);

  return {
    lineCount: rawLines.length,
    commandCount: commands.length,
    temperatures: {
      ...(temps.hotend !== undefined ? { hotend: temps.hotend } : {}),
      ...(temps.bed !== undefined ? { bed: temps.bed } : {}),
      placeholders: temps.placeholders,
    },
    material,
    firmwareLimitsKnown,
    findings,
  };
}

function severityRank(severity: StartGcodeSeverity): number {
  return severity === 'critical' ? 0 : severity === 'warning' ? 1 : 2;
}

function parseCommands(rawLines: string[]): Command[] {
  const commands: Command[] = [];
  rawLines.forEach((raw, index) => {
    const source = raw.trim();
    /* Marlin treats everything after ';' as a comment, and slicers put whole disabled commands
       there. A commented-out M500 is not an M500. */
    const stripped = source.split(';')[0]?.trim() ?? '';
    if (stripped === '') return;

    const head = /^([GM])\s*(\d+)(?:\.\d+)?\b/i.exec(stripped);
    if (!head) return;
    const code = `${(head[1] ?? '').toUpperCase()}${Number(head[2])}`;
    const body = stripped.slice(head[0].length);

    const placeholders = new Set<string>();
    const withoutPlaceholders = body.replace(PLACEHOLDER, (match, offset: number) => {
      const letter = /([A-Za-z])\s*$/.exec(body.slice(0, offset));
      if (letter?.[1]) placeholders.add(letter[1].toUpperCase());
      return ' ';
    });

    const params: Record<string, number> = {};
    const re = /([A-Za-z])\s*(-?\d*\.?\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(withoutPlaceholders)) !== null) {
      const key = (m[1] ?? '').toUpperCase();
      const value = Number(m[2]);
      if (Number.isFinite(value) && params[key] === undefined) params[key] = value;
    }

    commands.push({ line: index + 1, source, code, params, placeholders });
  });
  return commands;
}

type Temperatures = { hotend?: number; bed?: number; placeholders: boolean };

function collectTemperatures(commands: Command[]): Temperatures {
  const out: Temperatures = { placeholders: false };
  for (const cmd of commands) {
    const isHotend = cmd.code === 'M104' || cmd.code === 'M109';
    const isBed = cmd.code === 'M140' || cmd.code === 'M190';
    if (!isHotend && !isBed) continue;

    if (cmd.placeholders.has('S') || cmd.placeholders.has('R')) out.placeholders = true;
    const value = cmd.params['S'] ?? cmd.params['R'];
    if (value === undefined || value <= 0) continue;

    if (isHotend) out.hotend = Math.max(out.hotend ?? 0, value);
    else out.bed = Math.max(out.bed ?? 0, value);
  }
  return out;
}

/* Nearest filament preset by temperature. Shared with the live preset watch, so "this looks like
   PETG" means the same thing whether it was read out of a file or off the live targets. */
export function guessFilament(hotend?: number, bed?: number): MaterialGuess | null {
  if (hotend === undefined) return null;
  let best: MaterialGuess | null = null;
  for (const preset of FILAMENT_PRESETS) {
    const distance =
      Math.abs(hotend - preset.hotend) + (bed === undefined ? 0 : Math.abs(bed - preset.bed));
    if (!best || distance < best.distance) {
      best = { id: preset.id, name: preset.name, hotend: preset.hotend, bed: preset.bed, distance };
    }
  }
  return best;
}

function checkCalibrationWrites(commands: Command[], findings: StartGcodeFinding[]): void {
  const savesLater = (line: number) =>
    commands.some((cmd) => cmd.code === 'M500' && cmd.line > line);

  for (const cmd of commands) {
    if (cmd.code === 'M502') {
      findings.push({
        code: 'factory_reset',
        severity: 'critical',
        line: cmd.line,
        source: cmd.source,
        title: 'M502 сбрасывает прошивку к заводским значениям',
        detail:
          'Каждая печать с этим блоком стирает всю калибровку: шаги, PID, Z-offset, сетку. ' +
          (savesLater(cmd.line)
            ? 'Ниже есть M500 — значит сброс ещё и записывается в EEPROM, то есть переживает перезагрузку.'
            : 'В EEPROM это не пишется, но до следующего включения принтер работает на дефолтах.'),
        fix: 'Убрать M502 из стартового блока. Заводской сброс — разовая операция, а не часть каждой печати.',
      });
      continue;
    }

    if (cmd.code === 'M500') {
      findings.push({
        code: 'writes_eeprom',
        severity: 'critical',
        line: cmd.line,
        source: cmd.source,
        title: 'M500 пишет EEPROM на каждой печати',
        detail:
          'Всё, что блок изменил выше, становится постоянным и заменяет калибровку из 3DTune. ' +
          'Плюс расход ресурса: EEPROM эмулируется во flash MCU, ~10 000 циклов стирания на ячейку.',
        fix: 'Убрать M500. Сохранять настройки должен человек один раз, а не файл на каждой печати.',
      });
      continue;
    }

    if (cmd.code === 'M501') {
      findings.push({
        code: 'reloads_eeprom',
        severity: 'info',
        line: cmd.line,
        source: cmd.source,
        title: 'M501 перечитывает EEPROM',
        detail:
          'Всё, что выставлено в 3DTune в этой сессии и ещё не сохранено через M500, будет отброшено ' +
          'в момент старта печати.',
      });
      continue;
    }

    const what = CALIBRATION_COMMANDS[cmd.code];
    if (!what) continue;
    const permanent = savesLater(cmd.line);
    findings.push({
      code: 'overwrites_calibration',
      severity: permanent ? 'critical' : 'warning',
      line: cmd.line,
      source: cmd.source,
      title: `${cmd.code} переписывает калибровку (${what})`,
      detail: permanent
        ? 'Ниже в блоке есть M500 — значение из профиля слайсера записывается в EEPROM и вытесняет то, ' +
          'что настроено в 3DTune. Это и есть тот случай, когда калибровка «сама сбрасывается».'
        : 'До перезагрузки принтера действует значение из файла, а не из 3DTune. В EEPROM оно не попадает, ' +
          'но вся печать идёт на нём.',
      fix: `Убрать ${cmd.code} из стартового блока и держать это значение в прошивке через 3DTune.`,
    });
  }
}

function checkTemperatureLimits(
  commands: Command[],
  limits: MachineLimits,
  findings: StartGcodeFinding[],
): void {
  for (const cmd of commands) {
    const isHotend = cmd.code === 'M104' || cmd.code === 'M109';
    const isBed = cmd.code === 'M140' || cmd.code === 'M190';
    if (!isHotend && !isBed) continue;
    const value = cmd.params['S'] ?? cmd.params['R'];
    if (value === undefined) continue;

    const max = isHotend ? limits.hotendMax : limits.bedMax;
    if (value <= max) continue;
    findings.push({
      code: 'temperature_over_limit',
      severity: 'critical',
      line: cmd.line,
      source: cmd.source,
      title: `${value} °C выше рабочего потолка ${max} °C`,
      detail:
        (isHotend ? 'Сопло' : 'Стол') +
        ` греется до ${value} °C. 3DTune такую цель не даст выставить руками, но файл с SD ` +
        'исполняется прошивкой напрямую и хост его не фильтрует.',
      fix: 'Проверить профиль материала в слайсере. Если температура нужна — сверить пределы прошивки, ' +
        'а не подгонять потолок хоста.',
    });
  }
}

function checkMaterialMismatch(
  temps: Temperatures,
  material: MaterialGuess | null,
  presetId: string | undefined,
  findings: StartGcodeFinding[],
): void {
  if (!material || temps.hotend === undefined) return;

  const selected: FilamentPreset | undefined = presetId
    ? FILAMENT_PRESETS.find((preset) => preset.id === presetId)
    : undefined;

  if (material.distance > 40) {
    findings.push({
      code: 'material_unknown',
      severity: 'info',
      line: 0,
      source: '',
      title: `Профиль греет ${describeTemps(temps)} — это не похоже ни на один пресет 3DTune`,
      detail: 'Ближайший по температурам — ' + material.name + ', но расхождение слишком велико. ' +
        'Скорее всего это специальный пластик или профиль под другой хотэнд.',
    });
  } else {
    findings.push({
      code: 'material_guess',
      severity: 'info',
      line: 0,
      source: '',
      title: `Судя по температурам (${describeTemps(temps)}), это профиль ${material.name}`,
      detail: 'Температуру печати задаёт файл, а не пресет в 3DTune: M104/M109 из стартового блока ' +
        'исполняются прошивкой и перебивают предварительный нагрев.',
    });
  }

  if (!selected || selected.id === material.id) return;

  const hotendDelta = temps.hotend - selected.hotend;
  const bedDelta = temps.bed === undefined ? 0 : temps.bed - selected.bed;
  if (Math.abs(hotendDelta) < 15 && Math.abs(bedDelta) < 15) return;

  findings.push({
    code: 'material_mismatch',
    severity: 'warning',
    line: 0,
    source: '',
    title: `Выбран пресет ${selected.name}, а файл печатает как ${material.name}`,
    detail:
      `В 3DTune выбран ${selected.name} (сопло ${selected.hotend} °C, стол ${selected.bed} °C), ` +
      `а стартовый блок греет ${describeTemps(temps)}. Победит блок.`,
    fix: 'Либо сменить пресет в 3DTune на ' + material.name + ', либо перевыбрать материал в слайсере — ' +
      'но именно в слайсере, потому что печатать будут его температуры.',
  });
}

function describeTemps(temps: Temperatures): string {
  const parts: string[] = [];
  if (temps.hotend !== undefined) parts.push(`сопло ${temps.hotend} °C`);
  if (temps.bed !== undefined) parts.push(`стол ${temps.bed} °C`);
  return parts.join(', ');
}

function checkFirmwareLimits(
  commands: Command[],
  settings: Record<string, Record<string, number>> | undefined,
  findings: StartGcodeFinding[],
): boolean {
  const limitCommands = commands.filter((cmd) => LIMIT_FIELDS[cmd.code] !== undefined);
  if (limitCommands.length === 0) return settings !== undefined;

  if (!settings) {
    findings.push({
      code: 'limits_unknown',
      severity: 'info',
      line: limitCommands[0]?.line ?? 0,
      source: limitCommands[0]?.source ?? '',
      title: 'Блок задаёт лимиты движения, а прошивочные значения неизвестны',
      detail:
        'Сравнить M201/M203/M204/M205 из блока не с чем: настройки прошивки ещё не прочитаны. ' +
        'Подключись к принтеру и нажми «Прочитать M503», затем повтори разбор.',
      fix: 'Подключиться к принтеру и прочитать M503.',
    });
    return false;
  }

  for (const cmd of limitCommands) {
    const fields = LIMIT_FIELDS[cmd.code] ?? [];
    const firmware = settings[cmd.code];
    if (!firmware) continue;

    const over: string[] = [];
    for (const field of fields) {
      const requested = cmd.params[field];
      const allowed = firmware[field];
      if (requested === undefined || allowed === undefined) continue;
      if (requested > allowed) over.push(`${field}: ${requested} > ${allowed}`);
    }
    if (over.length === 0) continue;

    findings.push({
      code: 'above_firmware_limit',
      severity: 'warning',
      line: cmd.line,
      source: cmd.source,
      title: `${cmd.code} выше текущих значений прошивки (${LIMIT_TITLES[cmd.code] ?? cmd.code})`,
      detail:
        over.join(', ') +
        '. Команда не «пробьёт» механику насильно — она поднимет сам лимит прошивки на время печати, ' +
        'и планировщик будет разгоняться до нового значения.',
      fix: 'Либо убрать команду и оставить лимиты прошивки, либо осознанно поднять их в 3DTune и сохранить.',
    });
  }
  return true;
}

function checkLeveling(commands: Command[], findings: StartGcodeFinding[]): void {
  for (const cmd of commands) {
    if (cmd.code !== 'G29') continue;

    /* What G29's parameters mean depends on the levelling algorithm, and the algorithm is
       compile-time. reference/kp5l-marlin-2.1.1-abl is UBL, where G29 L<slot> loads a stored mesh
       and does not probe — but the same line on a BILINEAR or MBL build is an unknown argument
       Marlin ignores, leaving a full probing run. Naming both beats guessing one. */
    if (Object.keys(cmd.params).length > 0) {
      findings.push({
        code: 'probe_parameterised',
        severity: 'info',
        line: cmd.line,
        source: cmd.source,
        title: `${cmd.source} — смысл параметров зависит от прошивки`,
        detail:
          'Алгоритм левелинга компилируемый, по serial его не переключить. В комьюнити-сборке KP5L ' +
          'включён UBL: там G29 L<слот> загружает сохранённую сетку без зондирования, а снимает её ' +
          'G29 P1. На сборке с BILINEAR или MESH_BED_LEVELING такой параметр просто игнорируется, ' +
          'и это полный прогон зонда на каждой печати.',
        fix: 'Проверить, какой алгоритм в прошивке: отправить M503 и посмотреть, в каком виде ' +
          'выводится сетка (UBL печатает номера слотов).',
      });
      continue;
    }

    findings.push({
      code: 'probe_every_print',
      severity: 'warning',
      line: cmd.line,
      source: cmd.source,
      title: 'G29 снимает сетку заново перед каждой печатью',
      detail:
        'Это 2–4 минуты на печать и износ щупа BLTouch, при том что сетка уже лежит в EEPROM и не ' +
        'меняется, пока стол не трогали.',
      fix:
        'Снять сетку один раз в 3DTune и сохранить (M500), а из старта G29 убрать. Компенсация после ' +
        'G28: в комьюнити-сборке KP5L включён ENABLE_LEVELING_AFTER_G28, поэтому она остаётся ' +
        'активной сама. На стоковой прошивке это не проверено — проверь один раз: G28, затем M420 ' +
        'без параметров, и посмотри ответ. Если компенсация выключилась — добавь в старт M420 S1.',
    });
  }

  for (const cmd of commands) {
    if (cmd.code !== 'M420' || cmd.params['S'] !== 1) continue;
    findings.push({
      code: 'leveling_enable',
      severity: 'info',
      line: cmd.line,
      source: cmd.source,
      title: 'M420 S1 в стартовом блоке',
      detail:
        'Вреда нет. На комьюнити-сборке KP5L строка избыточна: ENABLE_LEVELING_AFTER_G28 включён, ' +
        'и компенсация после G28 остаётся сама. На стоковой прошивке поведение не проверено, там ' +
        'строка может быть как раз нужной.',
    });
  }

  const home = commands.find((cmd) => cmd.code === 'G28');
  const earlyProbe = commands.find(
    (cmd) => (cmd.code === 'G29' || cmd.code === 'G30') && (!home || cmd.line < home.line),
  );
  if (earlyProbe) {
    findings.push({
      code: 'probe_without_home',
      severity: 'critical',
      line: earlyProbe.line,
      source: earlyProbe.source,
      title: `${earlyProbe.code} без предшествующего G28`,
      detail: 'Marlin не знает положения осей и откажет («Home XYZ first»). Печать начнётся с несведённым столом.',
      fix: 'Поставить G28 выше по блоку.',
    });
  }
}

function checkHomingAndExtrusion(commands: Command[], findings: StartGcodeFinding[]): void {
  const hasMove = commands.some((cmd) => cmd.code === 'G0' || cmd.code === 'G1');
  /* An end block also moves without homing, and correctly so. A start block always heats something;
     an end block turns heat off. That is the cheap, reliable way to tell them apart. */
  const heats = commands.some(
    (cmd) =>
      ['M104', 'M109', 'M140', 'M190'].includes(cmd.code) &&
      ((cmd.params['S'] ?? cmd.params['R'] ?? 0) > 0 || cmd.placeholders.has('S') || cmd.placeholders.has('R')),
  );
  const probedWithoutHome = findings.some((f) => f.code === 'probe_without_home');
  if (!commands.some((cmd) => cmd.code === 'G28') && hasMove && heats && !probedWithoutHome) {
    findings.push({
      code: 'no_home',
      severity: 'warning',
      line: 0,
      source: '',
      title: 'В блоке нет G28',
      detail: 'Стартовый блок двигает оси, ни разу не выполнив парковку. Координаты будут отсчитываться ' +
        'от того, где голова оказалась после прошлой печати.',
      fix: 'Добавить G28 перед первым перемещением.',
    });
  }

  const wait = commands.find((cmd) => cmd.code === 'M109');
  const extrude = commands.find(
    (cmd) => (cmd.code === 'G0' || cmd.code === 'G1') && (cmd.params['E'] ?? 0) > 0,
  );
  if (extrude && (!wait || extrude.line < wait.line)) {
    findings.push({
      code: 'cold_extrude',
      severity: 'warning',
      line: extrude.line,
      source: extrude.source,
      title: 'Выдавливание до ожидания нагрева',
      detail: wait
        ? 'M104 только задаёт цель и не ждёт. К этой строке сопло может быть ещё холодным, и Marlin ' +
          'откажет по cold extrusion — линия очистки не напечатается.'
        : 'В блоке нет M109, то есть никто не ждёт нагрева перед подачей пластика.',
      fix: 'Поставить M109 S<температура> перед первым положительным E.',
    });
  }

  const hotendWait = commands.find((cmd) => cmd.code === 'M109');
  const bedWait = commands.find((cmd) => cmd.code === 'M190');
  if (hotendWait && bedWait && hotendWait.line < bedWait.line) {
    findings.push({
      code: 'heat_order',
      severity: 'info',
      line: hotendWait.line,
      source: hotendWait.source,
      title: 'Сопло ждёт нагрева раньше стола',
      detail: 'Пока греется стол (это дольше), горячее сопло стоит на месте и подтекает. К началу печати ' +
        'на нём будет капля.',
      fix: 'Порядок M140 → M190 → M109: стол греется первым, сопло догревается в конце.',
    });
  }
}

function checkDriverCurrent(commands: Command[], findings: StartGcodeFinding[]): void {
  for (const cmd of commands) {
    if (cmd.code !== 'M906' && cmd.code !== 'M907') continue;
    findings.push({
      code: 'driver_current',
      severity: 'warning',
      line: cmd.line,
      source: cmd.source,
      title: `${cmd.code} на KP5L ничего не меняет`,
      detail: 'На MKS Robin Nano стоят TMC2225 в standalone-режиме: ток задаётся подстроечным резистором, ' +
        'а не по UART. Команда пройдёт молча и не даст эффекта.',
      fix: 'Убрать строку, чтобы не создавать иллюзию настроенного тока.',
    });
  }
}

function checkPlaceholders(temps: Temperatures, findings: StartGcodeFinding[]): void {
  if (!temps.placeholders) return;
  findings.push({
    code: 'placeholders',
    severity: 'info',
    line: 0,
    source: '',
    title: 'В блоке есть подстановки слайсера',
    detail: 'Часть температур записана как {material_print_temperature} и подставится при нарезке. ' +
      'Сравнить их с пресетом можно только на готовом .gcode: вставь начало нарезанного файла.',
  });
}

/* ---------- what to hand back to the slicer ---------- */

export type CuraSetting = {
  field: string;
  value: string;
  /* Where the number came from: a firmware report, a host limit, or an assumption. Cura settings
     are typed in by hand, so the user has to know which rows they can trust. */
  source: 'M503' | 'host' | 'assumption';
  note?: string;
};

export type CuraExport = {
  rows: CuraSetting[];
  missing: string[];
};

/* Cura's Machine Settings dialog, field by field. Values it plans with should not exceed what the
   firmware will execute — otherwise the slicer's time estimate and its corner behaviour describe a
   printer that does not exist. */
export function curaMachineSettings(ctx: {
  limits: MachineLimits;
  settings?: Record<string, Record<string, number>> | undefined;
}): CuraExport {
  const s = ctx.settings ?? {};
  const rows: CuraSetting[] = [
    { field: 'X (width)', value: `${ctx.limits.bedSize.x}`, source: 'host' },
    { field: 'Y (depth)', value: `${ctx.limits.bedSize.y}`, source: 'host' },
    { field: 'Z (height)', value: `${ctx.limits.bedSize.z}`, source: 'host' },
    { field: 'Build plate shape', value: 'Rectangular', source: 'host' },
    { field: 'Origin at center', value: 'нет', source: 'host' },
    { field: 'Heated bed', value: 'да', source: 'host' },
    { field: 'G-code flavour', value: 'Marlin', source: 'host' },
    { field: 'Number of extruders', value: '1', source: 'host' },
    {
      field: 'Nozzle size',
      value: '0.4',
      source: 'assumption',
      note: 'диаметр сопла прошивка не знает — поставь свой, если он другой',
    },
  ];

  const missing: string[] = [];
  const add = (field: string, code: string, key: string, scale = 1): void => {
    const value = s[code]?.[key];
    if (value === undefined) {
      missing.push(`${field} (${code} ${key})`);
      return;
    }
    rows.push({ field, value: `${Math.round(value * scale * 100) / 100}`, source: 'M503' });
  };

  add('Maximum speed X', 'M203', 'X');
  add('Maximum speed Y', 'M203', 'Y');
  add('Maximum speed Z', 'M203', 'Z');
  add('Maximum speed E', 'M203', 'E');
  add('Maximum acceleration X', 'M201', 'X');
  add('Maximum acceleration Y', 'M201', 'Y');
  add('Maximum acceleration Z', 'M201', 'Z');
  add('Maximum acceleration E', 'M201', 'E');
  add('Print acceleration', 'M204', 'P');
  add('Travel acceleration', 'M204', 'T');

  /* Marlin builds run either classic jerk or junction deviation, never both. Reporting the one the
     firmware actually uses avoids handing Cura a jerk value the printer ignores. */
  const junction = s['M205']?.['J'];
  if (junction !== undefined && junction > 0) {
    rows.push({
      field: 'Junction deviation',
      value: `${junction}`,
      source: 'M503',
      note: 'прошивка использует junction deviation, а не классический jerk',
    });
  } else {
    add('Maximum X jerk', 'M205', 'X');
    add('Maximum Y jerk', 'M205', 'Y');
    add('Maximum Z jerk', 'M205', 'Z');
    add('Maximum E jerk', 'M205', 'E');
  }

  return { rows, missing };
}

export type StartBlockOptions = {
  limits: MachineLimits;
  hasProbe: boolean;
  hasMesh: boolean;
  levelingOn: boolean;
};

export type GeneratedBlock = {
  start: string[];
  end: string[];
  notes: string[];
};

/* A start block that deliberately carries no material: temperatures stay as Cura placeholders so
   the profile decides them. Hardcoding 205/60 here is exactly how "the PLA preset is selected but
   it heats like PETG" happens in the other direction. */
export function recommendedStartBlock(opts: StartBlockOptions): GeneratedBlock {
  const primeY = Math.max(20, opts.limits.bedSize.y - 40);
  const notes: string[] = [];

  const start = [
    ';--- 3DTune: стартовый блок ---',
    'M140 S{material_bed_temperature_layer_0}   ; стол греется первым — он дольше',
    'M104 S{material_print_temperature_layer_0} ; сопло греется параллельно, без ожидания',
    'M190 S{material_bed_temperature_layer_0}   ; ждём стол',
    'G28                                        ; парковка',
  ];

  if (opts.hasProbe && opts.hasMesh) {
    start.push('M420 S1                                    ; включить сохранённую сетку');
    notes.push(
      'M420 S1 оставлен намеренно. На комьюнити-сборке KP5L включён ENABLE_LEVELING_AFTER_G28, ' +
        'и строка там избыточна; на стоковой прошивке это не проверено, и там она может быть нужна. ' +
        'Лишняя строка безвредна, отсутствующая — стоит первого слоя.',
    );
    notes.push('G29 в старт не добавлен: сетка уже снята и лежит в EEPROM. Пересниматься на каждой печати ей незачем.');
  } else if (opts.hasProbe) {
    start.push('; сетки в EEPROM нет — сними её в 3DTune и сохрани, потом добавь сюда M420 S1');
    notes.push('Сетка не снята, поэтому строка включения компенсации не добавлена: включать нечего.');
  } else {
    notes.push('Прошивка не сообщает о зонде, поэтому строк компенсации стола в блоке нет.');
  }
  if (opts.hasMesh && !opts.levelingOn) {
    notes.push('Сетка есть, но компенсация сейчас выключена. M420 S1 в старте включит её на время печати.');
  }

  start.push(
    'M109 S{material_print_temperature_layer_0} ; ждём сопло — последним, чтобы меньше подтекало',
    'G92 E0                                     ; обнулить экструдер',
    `G1 X5 Y5 Z0.28 F3000                       ; к началу линии очистки`,
    `G1 X5 Y${primeY} Z0.28 E${((primeY - 5) * 0.055).toFixed(1)} F1200   ; линия очистки вдоль левого края`,
    'G92 E0',
    'G1 X10 Z2 F3000                            ; отвести от линии',
  );

  const end = [
    ';--- 3DTune: конечный блок ---',
    'M104 S0',
    'M140 S0',
    'M107',
    'G91',
    'G1 E-3 F1800                               ; втянуть пруток',
    'G1 Z10 F600                                ; поднять сопло над деталью',
    'G90',
    `G1 X0 Y${opts.limits.bedSize.y} F3000                       ; вывезти стол вперёд`,
    'M84',
  ];

  notes.push(
    'Ни одной команды калибровки: M92, M301, M304, M851, M500 и M502 в стартовом блоке быть не должно — ' +
      'иначе профиль слайсера будет спорить с тем, что настроено в 3DTune.',
  );

  return { start, end, notes };
}
