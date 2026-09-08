import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CallRecord } from "./types.js";
import { redact } from "./logger.js";

/**
 * File-backed call history: one JSON per task under DATA_DIR/calls, plus an
 * idempotency index. Simple, greppable, no native deps. Swap for sqlite later
 * by re-implementing these five methods.
 */
export class CallStore {
  private cache = new Map<string, CallRecord>();
  private idem = new Map<string, string>();
  constructor(private dir: string) {
    mkdirSync(join(dir, "calls"), { recursive: true });
    for (const f of readdirSync(join(dir, "calls"))) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(dir, "calls", f), "utf8")) as CallRecord;
        this.cache.set(rec.task_id, rec);
        this.idem.set(`${rec.provider}:${rec.idempotency_key}`, rec.task_id);
      } catch {
        /* corrupt file: skip, never crash startup */
      }
    }
  }

  get(task_id: string): CallRecord | undefined {
    return this.cache.get(task_id);
  }
  findByCallId(call_id: string): CallRecord | undefined {
    for (const r of this.cache.values()) if (r.call_id === call_id) return r;
    return undefined;
  }
  findByIdempotency(provider: string, key: string): CallRecord | undefined {
    const id = this.idem.get(`${provider}:${key}`);
    return id ? this.cache.get(id) : undefined;
  }
  list(): CallRecord[] {
    return [...this.cache.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  save(rec: CallRecord): void {
    rec.updated_at = new Date().toISOString();
    this.cache.set(rec.task_id, rec);
    this.idem.set(`${rec.provider}:${rec.idempotency_key}`, rec.task_id);
    const path = join(this.dir, "calls", `${rec.task_id}.json`);
    writeFileSync(path, JSON.stringify(redact(rec), null, 2));
  }
  appendEvent(task_id: string, type: string, data?: Record<string, unknown>): void {
    const rec = this.cache.get(task_id);
    if (!rec) return;
    rec.events.push({ at: new Date().toISOString(), type, data: data ? redact(data) : undefined });
    this.save(rec);
  }
  exists(task_id: string): boolean {
    return this.cache.has(task_id) || existsSync(join(this.dir, "calls", `${task_id}.json`));
  }
}
