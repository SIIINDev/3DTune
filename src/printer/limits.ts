import { KP5L_BED_SCREWS, type BedScrewGeometry } from './mesh.ts';

export type MachineLimits = {
  hotendMax: number;
  bedMax: number;
  confirmAboveHotend: number;
  minExtrudeTemp: number;
  bedSize: { x: number; y: number; z: number };
  bedScrews: BedScrewGeometry;
  eepromSaveMinIntervalMs: number;
};

/* Host-side operating caps, deliberately BELOW the firmware's fault thresholds.
   Stock KP5L robin_nano_cfg.txt declares HEATER_0_MAXTEMP 275 and BED_MAXTEMP 150 — those are
   the thermal-protection kill points, not safe targets. Marlin exposes neither over serial, so
   these are an assumption about this specific machine: confirm against the firmware in Phase 0
   and override via ~/.3dtune/config.json if your build differs. */
export const KP5L_LIMITS: MachineLimits = {
  hotendMax: 265,
  bedMax: 110,
  confirmAboveHotend: 250,
  minExtrudeTemp: 170,
  bedSize: { x: 300, y: 300, z: 330 },
  bedScrews: KP5L_BED_SCREWS,
  eepromSaveMinIntervalMs: 3_000,
};

/* Config supplies partial values at every level, so the override type has to be deep-partial —
   Partial<MachineLimits> would demand a complete bedScrews object. */
export type MachineLimitOverrides = Partial<Omit<MachineLimits, 'bedSize' | 'bedScrews'>> & {
  bedSize?: Partial<MachineLimits['bedSize']>;
  bedScrews?: Partial<BedScrewGeometry>;
};

export function resolveLimits(overrides?: MachineLimitOverrides): MachineLimits {
  if (!overrides) return KP5L_LIMITS;
  const merged: MachineLimits = {
    ...KP5L_LIMITS,
    ...overrides,
    bedSize: { ...KP5L_LIMITS.bedSize, ...overrides.bedSize },
    bedScrews: { ...KP5L_LIMITS.bedScrews, ...overrides.bedScrews },
  };
  // A non-positive pitch would divide by zero and a huge inset would sample outside the bed.
  if (!(merged.bedScrews.pitchMm > 0)) merged.bedScrews.pitchMm = KP5L_BED_SCREWS.pitchMm;
  merged.bedScrews.inset = Math.min(Math.max(merged.bedScrews.inset, 0), Math.min(merged.bedSize.x, merged.bedSize.y) / 2 - 1);
  if (!(merged.bedScrews.deadbandMm >= 0)) merged.bedScrews.deadbandMm = KP5L_BED_SCREWS.deadbandMm;
  merged.hotendMax = Math.min(merged.hotendMax, 300);
  merged.bedMax = Math.min(merged.bedMax, 150);
  return merged;
}

export class SafetyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'SafetyError';
  }
}

export function checkHotendTarget(value: number, limits: MachineLimits, confirmed: boolean): void {
  if (!Number.isFinite(value) || value < 0) throw new SafetyError('bad_value', 'target must be >= 0');
  if (value > limits.hotendMax) {
    throw new SafetyError('over_max', `hotend target ${value}C exceeds limit ${limits.hotendMax}C`);
  }
  if (value > limits.confirmAboveHotend && !confirmed) {
    throw new SafetyError(
      'needs_confirm',
      `hotend target ${value}C is above ${limits.confirmAboveHotend}C and needs explicit confirmation`,
    );
  }
}

export function checkBedTarget(value: number, limits: MachineLimits): void {
  if (!Number.isFinite(value) || value < 0) throw new SafetyError('bad_value', 'target must be >= 0');
  if (value > limits.bedMax) {
    throw new SafetyError('over_max', `bed target ${value}C exceeds limit ${limits.bedMax}C`);
  }
}

export function checkExtrude(hotendCurrent: number, limits: MachineLimits): void {
  if (hotendCurrent < limits.minExtrudeTemp) {
    throw new SafetyError(
      'cold_extrude',
      `hotend is ${hotendCurrent.toFixed(1)}C, needs at least ${limits.minExtrudeTemp}C to move E`,
    );
  }
}

export function checkJog(
  axis: 'X' | 'Y' | 'Z' | 'E',
  distance: number,
  homed: { x: boolean; y: boolean; z: boolean },
): void {
  if (!Number.isFinite(distance)) throw new SafetyError('bad_value', 'distance must be a number');
  if (Math.abs(distance) > 400) throw new SafetyError('too_far', 'single jog is limited to 400 mm');
  if (axis === 'E') return;
  const key = axis.toLowerCase() as 'x' | 'y' | 'z';
  if (!homed[key]) {
    throw new SafetyError('not_homed', `${axis} is not homed — run G28 first`);
  }
}
