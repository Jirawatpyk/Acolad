import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';

/**
 * Summarize p95 latency from the JSON logs for acceptance:
 *   - cycle / send  → detection + dispatch latency (SC-002).
 *   - accept click  → detection → confirm-click, budget ≤ 5 s (Constitution VIII, V16).
 *   - accept outcome→ detection → FR-024-confirmed outcome, ≤ 60 s (SC-003, V16b).
 *
 * The two accept metrics are measured SEPARATELY (N1): the click is stamped right
 * after the confirm-click, the outcome after the authoritative re-read of Active —
 * so the re-read cost shows up in `outcome` but not `click`. Accept entries only
 * appear once ACCEPT_ENABLED=1 produces real accepts; until then the accept counts
 * are 0 and the budget verdicts are vacuously PASS.
 */

/** ≤ 5 s detection → confirm-click (Constitution VIII / V16). */
export const CLICK_LATENCY_BUDGET_MS = 5_000;
/** ≤ 60 s detection → FR-024-confirmed outcome end-to-end (SC-003 / V16b). */
export const OUTCOME_LATENCY_BUDGET_MS = 60_000;

export interface LatencyMetric {
  count: number;
  p95: number;
}

export interface LatencyReport {
  cycle: LatencyMetric;
  send: LatencyMetric;
  acceptClick: LatencyMetric;
  acceptOutcome: LatencyMetric;
  /** p95 click latency within the 5 s budget (vacuously true when count = 0). */
  acceptClickPass: boolean;
  /** p95 outcome latency within the 60 s budget (vacuously true when count = 0). */
  acceptOutcomePass: boolean;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

const metric = (values: number[]): LatencyMetric => ({
  count: values.length,
  p95: percentile(values, 95),
});

interface LogEntry {
  action?: string;
  outcome?: string;
  latencyMs?: number;
  clickLatencyMs?: number;
  outcomeLatencyMs?: number;
}

/**
 * Pure log-line reducer — testable without touching the filesystem. Tolerates
 * non-JSON lines and entries missing the latency field.
 */
export function computeLatencyMetrics(lines: Iterable<string>): LatencyReport {
  const cycle: number[] = [];
  const send: number[] = [];
  const acceptClick: number[] = [];
  const acceptOutcome: number[] = [];

  for (const line of lines) {
    if (!line) continue;
    let e: LogEntry;
    try {
      e = JSON.parse(line) as LogEntry;
    } catch {
      continue; // skip non-JSON lines
    }
    if (e.action === 'cycle' && e.outcome === 'ok' && typeof e.latencyMs === 'number') {
      cycle.push(e.latencyMs);
    } else if (e.action === 'send' && e.outcome === 'ok' && typeof e.latencyMs === 'number') {
      send.push(e.latencyMs);
    } else if (e.action === 'accept') {
      if (typeof e.clickLatencyMs === 'number') acceptClick.push(e.clickLatencyMs);
      if (typeof e.outcomeLatencyMs === 'number') acceptOutcome.push(e.outcomeLatencyMs);
    }
  }

  const acceptClickMetric = metric(acceptClick);
  const acceptOutcomeMetric = metric(acceptOutcome);
  return {
    cycle: metric(cycle),
    send: metric(send),
    acceptClick: acceptClickMetric,
    acceptOutcome: acceptOutcomeMetric,
    acceptClickPass:
      acceptClickMetric.count === 0 || acceptClickMetric.p95 <= CLICK_LATENCY_BUDGET_MS,
    acceptOutcomePass:
      acceptOutcomeMetric.count === 0 || acceptOutcomeMetric.p95 <= OUTCOME_LATENCY_BUDGET_MS,
  };
}

/** Read every `acolad*.log` line from a directory (one JSON object per line). */
function readLogLines(logDir: string): string[] {
  if (!existsSync(logDir)) return [];
  const files = readdirSync(logDir).filter((f) => f.startsWith('acolad') && f.endsWith('.log'));
  const lines: string[] = [];
  for (const f of files) {
    lines.push(...readFileSync(join(logDir, f), 'utf8').split('\n').filter(Boolean));
  }
  return lines;
}

function verdict(pass: boolean, count: number): string {
  if (count === 0) return 'no data (accept off / no accepts yet)';
  return pass ? 'PASS' : 'FAIL';
}

function main(): void {
  const cfg = loadConfig();
  if (!existsSync(cfg.LOG_DIR)) {
    console.log('no logs directory yet');
    return;
  }
  const r = computeLatencyMetrics(readLogLines(cfg.LOG_DIR));

  console.log('=== Acolad latency report ===');
  console.log(`poll cycles (ok): ${r.cycle.count}, p95 = ${r.cycle.p95} ms`);
  console.log(`notifications (ok): ${r.send.count}, p95 = ${r.send.p95} ms`);
  console.log('--- accept (V16 / V16b) ---');
  console.log(
    `click latency (detection→confirm-click): ${r.acceptClick.count} samples, ` +
      `p95 = ${r.acceptClick.p95} ms / budget ${CLICK_LATENCY_BUDGET_MS} ms → ` +
      `${verdict(r.acceptClickPass, r.acceptClick.count)}`,
  );
  console.log(
    `outcome latency (detection→FR-024 confirmed): ${r.acceptOutcome.count} samples, ` +
      `p95 = ${r.acceptOutcome.p95} ms / budget ${OUTCOME_LATENCY_BUDGET_MS} ms → ` +
      `${verdict(r.acceptOutcomePass, r.acceptOutcome.count)}`,
  );
  console.log('(detection SC-001b is measured from poll start-to-start spacing in cycle logs)');
}

// Run only when invoked as the entry point (`node dist/runtime/latencyReport.js`),
// never when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
