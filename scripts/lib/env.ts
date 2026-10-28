import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ENV_FILE = path.join(process.cwd(), ".env.local");

export function readEnvFile(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) out[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

// Loads .env.local into process.env without overriding values already set in the shell.
export function loadEnvFile(): void {
  for (const [key, value] of Object.entries(readEnvFile())) {
    process.env[key] ??= value;
  }
}

export function writeEnvFile(values: Record<string, string>): void {
  const merged = { ...readEnvFile(), ...values };
  const body = Object.entries(merged)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  writeFileSync(ENV_FILE, `# Written by npm run setup. Do not commit this file.\n${body}\n`, { mode: 0o600 });
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}
