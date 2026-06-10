import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Deterministic record of cold-start timestamps, stored OUTSIDE the state dir
 * (FR-015). If a cold start recurs within 7 days it signals abnormal state loss
 * — detection here does not depend on scanning rotating logs.
 */
export class ColdStartHistory {
  private readonly file: string;

  constructor(logDir: string) {
    mkdirSync(logDir, { recursive: true });
    this.file = join(logDir, 'cold-start-history.json');
  }

  private read(): string[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed.filter((x) => typeof x === 'string') as string[]) : [];
    } catch {
      return [];
    }
  }

  /** Record a cold start; returns true if another occurred within the prior 7 days. */
  record(nowIso: string): boolean {
    const history = this.read();
    const nowMs = Date.parse(nowIso);
    const sevenDaysMs = 7 * 24 * 3_600_000;
    const recent = history.some((iso) => nowMs - Date.parse(iso) < sevenDaysMs);
    history.push(nowIso);
    // Keep only the last 30 days to bound file size.
    const kept = history.filter((iso) => nowMs - Date.parse(iso) < 30 * 24 * 3_600_000);
    writeFileSync(this.file, JSON.stringify(kept), 'utf8');
    return recent;
  }
}
