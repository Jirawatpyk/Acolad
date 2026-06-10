import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config/index.js';

/**
 * Summarize p95 detection/dispatch latency from the JSON logs for acceptance
 * (SC-001 layer b / SC-002). Reads poll-cycle and dispatcher entries and reports
 * the p95 of cycle latency and notification send latency.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

function main(): void {
  const cfg = loadConfig();
  if (!existsSync(cfg.LOG_DIR)) {
    console.log('no logs directory yet');
    return;
  }
  const files = readdirSync(cfg.LOG_DIR).filter(
    (f) => f.startsWith('acolad') && f.endsWith('.log'),
  );
  const cycleLatencies: number[] = [];
  const sendLatencies: number[] = [];

  for (const f of files) {
    const lines = readFileSync(join(cfg.LOG_DIR, f), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as { action?: string; outcome?: string; latencyMs?: number };
        if (typeof e.latencyMs !== 'number') continue;
        if (e.action === 'cycle' && e.outcome === 'ok') cycleLatencies.push(e.latencyMs);
        if (e.action === 'send' && e.outcome === 'ok') sendLatencies.push(e.latencyMs);
      } catch {
        // skip non-JSON lines
      }
    }
  }

  console.log('=== Acolad latency report ===');
  console.log(
    `poll cycles (ok): ${cycleLatencies.length}, p95 = ${percentile(cycleLatencies, 95)} ms`,
  );
  console.log(
    `notifications (ok): ${sendLatencies.length}, p95 = ${percentile(sendLatencies, 95)} ms`,
  );
  console.log('(detection SC-001b is measured from poll start-to-start spacing in cycle logs)');
}

main();
