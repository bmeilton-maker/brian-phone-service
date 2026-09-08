import { config } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const SECRET_KEYS = /(api[_-]?key|authorization|auth[_-]?token|secret|password|card|cvv|token)/i;

/** Deep-redact anything that looks like a secret so it never lands in logs or stored records. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) && typeof v === "string" && v ? "[REDACTED]" : redact(v, depth + 1);
  }
  return out as T;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[(config.logLevel as Level) ?? "info"]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(fields ? redact(fields) : {}) });
  // MCP stdio servers own stdout; everything goes to stderr.
  process.stderr.write(line + "\n");
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};
