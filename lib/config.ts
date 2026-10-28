import { DEFAULT_LIMITS, Limits } from "./guard";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}. Run "npm run setup" or see .env.example.`);
  return value;
}

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";

export function limits(): Limits {
  return {
    maxCells: numberEnv("MAX_CELLS_PER_REQUEST", DEFAULT_LIMITS.maxCells),
    confirmAboveUnits: numberEnv("CONFIRM_CHANGE_ABOVE_UNITS", DEFAULT_LIMITS.confirmAboveUnits),
    confirmRatio: numberEnv("CONFIRM_CHANGE_RATIO", DEFAULT_LIMITS.confirmRatio),
  };
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
