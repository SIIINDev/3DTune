import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AppConfig = {
  token: string;
  port: number;
  lastPortPath?: string;
  lastBaud?: number;
  limits?: {
    hotendMax?: number;
    bedMax?: number;
    confirmAboveHotend?: number;
    minExtrudeTemp?: number;
  };
  bedScrews?: {
    inset?: number;
    pitchMm?: number;
    tighteningLowersBed?: boolean;
    deadbandMm?: number;
  };
  deadmanMinutes?: number;
};

export function deadmanMs(config: AppConfig): number | undefined {
  const minutes = config.deadmanMinutes;
  if (minutes === undefined) return undefined;
  if (!Number.isFinite(minutes) || minutes < 0) return undefined;
  return Math.round(minutes * 60_000);
}

const DIR = join(homedir(), '.3dtune');
const FILE = join(DIR, 'config.json');

export function loadConfig(): AppConfig {
  let invalidReason: string | null = null;
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<AppConfig>;
    if (typeof raw.token === 'string' && raw.token.length >= 16) {
      return { token: raw.token, port: raw.port ?? 8420, ...raw } as AppConfig;
    }
    invalidReason = 'token is missing or too short';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      invalidReason = err instanceof Error ? err.message : String(err);
    }
  }
  if (invalidReason) process.stderr.write(`warning: invalid ${FILE} (${invalidReason}); creating a fresh config\n`);
  const fresh: AppConfig = { token: randomBytes(16).toString('base64url'), port: 8420 };
  saveConfig(fresh);
  return fresh;
}

export function rotateToken(config: AppConfig): AppConfig {
  const rotated = { ...config, token: randomBytes(16).toString('base64url') };
  saveConfig(rotated);
  return rotated;
}

export function saveConfig(config: AppConfig): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(FILE, 0o600);
}

export const CONFIG_PATH = FILE;
