/**
 * Phase 0 probe entry point — `npm run straker:recon`.
 *
 * READ ONLY BY CONSTRUCTION. It logs in, reads the open-offer list on a timer, captures
 * what it has never seen, and writes an event log. It performs no state-changing request
 * against Straker; the whole point of Phase 0 is to answer "what does an offer look like
 * and how long does one live?" before feature 003 is specified.
 *
 * It shares nothing with the live XTM bot: its own config schema, its own process, its
 * own output directory.
 */

import { config as loadDotenv } from 'dotenv';
import { createCaptureStore } from './captureStore.js';
import { loadStrakerReconConfig } from './config.js';
import { createHttpClient } from './httpClient.js';
import { listOpenOffers } from './offersApi.js';
import { runProbeCycle } from './probe.js';
import type { ProbeDeps } from './probe.js';
import { openSession } from './session.js';

loadDotenv();

async function main(): Promise<void> {
  const cfg = loadStrakerReconConfig(process.env);
  const client = createHttpClient({ baseUrl: cfg.baseUrl });
  const store = createCaptureStore(cfg.captureDir);

  const credentials = {
    loginId: cfg.loginId,
    password: cfg.password,
    ...(cfg.totpCode === undefined ? {} : { totpCode: cfg.totpCode }),
  };

  let session = await openSession(client, credentials);
  log({ event: 'probe_started', vendorId: session.vendorId, pollIntervalMs: cfg.pollIntervalMs });

  const deps: ProbeDeps = {
    vendorId: session.vendorId,
    listOpenOffers: (vendorId) => listOpenOffers(client, vendorId),
    captureOffer: (objId, payload, atMs) => store.captureOffer(objId, payload, atMs),
    recordEvent: async (probeEvent) => {
      await store.recordEvent(probeEvent);
      log(probeEvent);
    },
    reopenSession: async () => {
      session = await openSession(client, credentials);
      log({ event: 'session_reopened', vendorId: session.vendorId });
    },
    now: () => Date.now(),
  };

  let state = store.loadState();
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopping = true;
    });
  }

  while (!stopping) {
    const startedAt = Date.now();
    const outcome = await runProbeCycle(deps, state);
    state = outcome.state;
    await store.saveState(state);

    log({
      event: 'cycle',
      ok: outcome.ok,
      liveOffers: state.live.length,
      rttMs: Date.now() - startedAt,
      rateLimit: client.lastRateLimit(),
    });

    await sleep(cfg.pollIntervalMs);
  }

  log({ event: 'probe_stopped', distinctOffersSeen: state.sightingsByObjId.length });
}

function log(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...fields })}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  log({ event: 'probe_failed', reason: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
