import type { HeartbeatPinger } from '../../../src/monitoring/heartbeat.js';
import type { Logger } from '../../../src/monitoring/logger.js';
import type { StrakerCycle } from '../../../src/straker/main.js';

/** A logger that records nothing — the tests here assert behaviour, not log lines. */
export function silentLogger(): Logger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

export interface RecordingPinger extends HeartbeatPinger {
  readonly pings: readonly ('ok' | 'fail')[];
}

/** Records which liveness signal was sent, without touching the network. */
export function recordingPinger(): RecordingPinger {
  const pings: ('ok' | 'fail')[] = [];
  return {
    get pings() {
      return pings;
    },
    ok: async () => void pings.push('ok'),
    fail: async () => void pings.push('fail'),
  };
}

/**
 * A cycle that succeeds and does nothing. Phase 2 proves the bot can start, hold its lock
 * and be seen to be alive; what a cycle actually does is Phase 3 (T037).
 */
export function idleCycle(outcome: boolean | (() => boolean) = true): StrakerCycle {
  return { runOnce: async () => (typeof outcome === 'function' ? outcome() : outcome) };
}
