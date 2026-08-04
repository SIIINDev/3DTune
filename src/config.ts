import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
};

const DIR = join(homedir(), '.3dtune');
const FILE = join(DIR, 'config.json');

export function loadConfig(): AppConfig {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<AppConfig>;
    if (typeof raw.token === 'string' && raw.token.length >= 16) {
      return { token: raw.token, port: raw.port ?? 8420, ...raw } as AppConfig;
    }
  } catch {
    // fall through to fresh config
  }
  const fresh: AppConfig = { token: randomBytes(16).toString('base64url'), port: 8420 };
  saveConfig(fresh);
  return fresh;
}

export function saveConfig(config: AppConfig): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export const CONFIG_PATH = FILE;
