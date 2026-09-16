/**
 * Straker live-portal smoke path (T069, Constitution II).
 *
 * Sign in, read the open-offer list, confirm it still has the shape the parser was built
 * against, stop. Nothing else. This is the one test in the repo that talks to the real
 * portal with real credentials.
 *
 * ## How it is kept out of a normal run
 *
 * `vitest.config.ts` collects `tests/**\/*.test.ts` with no path exclusions, so this file
 * IS collected by `npx vitest run` — what stops it executing is the env flag below, the
 * same `LIVE_PORTAL=1` convention `scripts/xtm-recon.ts` and `scripts/recon-logout.ts`
 * already refuse to run without. Without it the suite reports as skipped and issues no
 * request. `.github/workflows/ci.yml` never sets the variable, and says in a comment that
 * it never will; do not add it there.
 *
 *   $env:LIVE_PORTAL='1'; npx vitest run tests/live/straker/smoke.test.ts
 *
 * Run it deliberately, supervised, on the bot host — not in a loop. It costs three
 * requests against a budget the capture probe and (once released) the bot are also
 * spending (SC-003, RP-5).
 *
 * ## Why it cannot claim
 *
 * A claim is irreversible, and RP-4 says the first real one happens once, deliberately,
 * under supervision — never as a side effect of running a test. Three independent things
 * have to be true for a claim to leave this file, and all three are structural rather than
 * a comment asking nicely:
 *
 * 1. **Nothing here imports the claim path.** No `claimOffer`, no `claimRequestPath`, no
 *    `createStrakerPortal` / `assembleStrakerBot` (either would hand over a `ClaimDoor`).
 *    The transport is built here, for this file, out of the read modules only.
 * 2. **The wire refuses it.** The client is built on {@link readOnlyFetch}, which allows
 *    any GET and exactly one POST — the sign-in endpoint — and throws
 *    {@link LiveSmokeRefusal} for everything else *before* calling the real `fetch`. A
 *    future edit that adds a claim fails at the socket, not in review.
 * 3. **The reader has no POST to call.** `listOpenOffers` is handed
 *    {@link readOnlyClient}, whose `postJson` throws. Sign-in uses the full client and
 *    then it is not passed on.
 *
 * Layer 2 is asserted below rather than assumed, using the real claim URL shape written
 * out as a literal — deliberately not imported, so importing it is not normalised here.
 */

import { config as loadDotenv } from 'dotenv';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadStrakerReconConfig, type StrakerReconConfig } from '../../../src/straker/config.js';
import {
  createHttpClient,
  type RateLimitSnapshot,
  type StrakerHttpClient,
} from '../../../src/straker/httpClient.js';
import type { Logger } from '../../../src/monitoring/logger.js';
import { listOpenOffers } from '../../../src/straker/offersApi.js';
import { parseOffer, STRAKER_DEADLINE_ZONE } from '../../../src/straker/offerParse.js';
import { openSession } from '../../../src/straker/session.js';
import type { RawOffer } from '../../../src/straker/probe.js';

/**
 * The gate. Read straight from `process.env` rather than through a config field, because
 * the decision must not depend on a schema parse succeeding: a config error has to leave
 * this suite skipped, not turn it into a failing test in a CI run that never wanted it.
 */
const LIVE = process.env['LIVE_PORTAL'] === '1';

/** The only path this file may POST to. Sign-in, and nothing else. */
const SIGN_IN_PATH = '/api/vendor/auth/login';

/**
 * A claim URL, written out rather than imported from `claim.ts`.
 *
 * `claimRequestPath()` is the real source of this shape, and importing it here would put
 * the claim module one autocomplete away from being used. A literal cannot drift silently
 * either: if the real path ever changes, layer 2 still refuses it — the allowlist names
 * what is *permitted*, so anything unrecognised is denied by default. This constant only
 * exists so the refusal can be demonstrated on a realistic input.
 */
const A_CLAIM_URL_SHAPE = '/api/vendors/vendor-1/job-offers/offer-1/claim';

/** Per-attempt deadline (Constitution VI). Matches the bot's own `REQUEST_TIMEOUT_MS`. */
const REQUEST_TIMEOUT_MS = 2_000;

/** Thrown before a request leaves the process, so it can never be mistaken for a portal
 *  reply. Named so a failure reads as "the smoke test stopped this", not as a network fault. */
class LiveSmokeRefusal extends Error {
  constructor(method: string, url: string) {
    super(
      `live smoke test refused to send ${method} ${url} — this file may only GET, and may ` +
        `POST only to ${SIGN_IN_PATH}. Claiming is irreversible and happens once, under ` +
        'supervision (RP-4), never from a test.',
    );
    this.name = 'LiveSmokeRefusal';
  }
}

/**
 * The wire guard (layer 2). Wraps the platform `fetch` and lets through only what reading
 * the portal genuinely needs.
 *
 * Both halves matter. The method check alone would allow a POST to any path once sign-in
 * is permitted; the path check alone would allow a DELETE. The allowlist is positive —
 * anything not named is refused — so a method or an endpoint nobody thought of is denied
 * rather than waved through.
 */
function readOnlyFetch(realFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const allowed =
      method === 'GET' || (method === 'POST' && new URL(url).pathname === SIGN_IN_PATH);
    if (!allowed) throw new LiveSmokeRefusal(method, url);
    return realFetch(input, init);
  };
}

/**
 * The reader's client (layer 3): the same transport with its one mutating method removed.
 * `listOpenOffers` only ever calls `getJson`, and after this it could not call anything
 * else even if it wanted to.
 *
 * **Written out member by member rather than as `{ ...client, postJson }` on purpose.** A
 * spread would silently carry any door the transport grows later — including a mutating one
 * — into something this file calls "read-only". Listing them means a new member on
 * `StrakerHttpClient` breaks this function's typecheck, and whoever is adding the door has
 * to say here whether it reads or writes. That break is the feature; do not fix it with a
 * spread. (Layer 2 still refuses the request at the wire either way — this layer is the
 * narrowing, not the last line of defence.)
 */
function readOnlyClient(client: StrakerHttpClient): StrakerHttpClient {
  return {
    getJson<T>(path: string): Promise<T> {
      return client.getJson<T>(path);
    },
    getJsonWithBackoff<T>(path: string): Promise<T> {
      return client.getJsonWithBackoff<T>(path);
    },
    postJson<T>(path: string): Promise<T> {
      return Promise.reject(new LiveSmokeRefusal('POST', path));
    },
    lastRateLimit: () => client.lastRateLimit(),
  };
}

/** Warnings from the parser are the interesting output of this run, so they are shown.
 *  `console.error` is the only console method the lint rules allow. */
const smokeLogger: Logger = {
  info: () => {},
  warn: (fields, msg) => console.error('[smoke] warn', msg ?? '', JSON.stringify(fields)),
  error: (fields, msg) => console.error('[smoke] error', msg ?? '', JSON.stringify(fields)),
};

function report(line: string): void {
  console.error(`[smoke] ${line}`);
}

interface SmokeResult {
  readonly cfg: StrakerReconConfig;
  readonly vendorId: string;
  readonly offers: readonly RawOffer[];
  readonly budget: RateLimitSnapshot | null;
  readonly guardedFetch: typeof fetch;
}

// `runIf` rather than an early return: with the flag unset the suite is reported as
// skipped, which is visible evidence in the run output that it did not execute.
describe.runIf(LIVE)('Straker live portal — read-only smoke path', () => {
  // Definite-assignment assertion: `beforeAll` fills it, and a failure there fails every
  // test in the suite before any of them reads this.
  let result!: SmokeResult;

  beforeAll(async () => {
    loadDotenv();
    // The READ-ONLY loader on purpose. `loadStrakerBotConfig` additionally requires the
    // ceiling, the sheet, the webhooks and the ping URL — none of which a read touches,
    // and every one of which would turn a missing reporting variable into a false failure
    // of the portal smoke path. A missing credential still fails fast, naming itself.
    const cfg = loadStrakerReconConfig(process.env);
    const guardedFetch = readOnlyFetch();

    const client = createHttpClient({
      baseUrl: cfg.baseUrl,
      fetchImpl: guardedFetch,
      // No unbounded waits, even here (Constitution VI).
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    // Request 1 + 2: sign in, then read the vendor id back from the portal.
    const session = await openSession(client, {
      loginId: cfg.loginId,
      password: cfg.password,
      ...(cfg.totpCode === undefined ? {} : { totpCode: cfg.totpCode }),
    });

    // Request 3, through the door that cannot POST. Single attempt (no `retry`): a smoke
    // run should report a failing portal, not quietly paper over it with three more tries.
    const offers = await listOpenOffers(readOnlyClient(client), session.vendorId);

    result = {
      cfg,
      vendorId: session.vendorId,
      offers,
      budget: client.lastRateLimit(),
      guardedFetch,
    };
    report(`base ${cfg.baseUrl} · vendor resolved · ${offers.length} open offer(s)`);
  }, 60_000);

  it('signs in and resolves a vendor id from the portal rather than from configuration', () => {
    expect(result.vendorId).toMatch(/\S/);
    // FR-022: the id is read back from `/auth/me` on every sign-in and never pinned in
    // configuration, because it changes under impersonation or an account switch and a
    // stale one would poll somebody else's offer list. Compared as a boolean so a failure
    // prints `true`/`false` — never a credential — into the run output.
    expect(result.vendorId === result.cfg.loginId).toBe(false);
  });

  it('returns the open-offer list as a bare array of identified entries', () => {
    // `listOpenOffers` already throws on an envelope or a missing `obj_id` — this restates
    // the guarantee at the level a reader of the run output cares about.
    expect(Array.isArray(result.offers)).toBe(true);
    for (const offer of result.offers) {
      expect(typeof offer.obj_id).toBe('string');
      expect(offer.obj_id).not.toBe('');
    }
  });

  it('still produces the shape the parser expects, for every offer currently listed', () => {
    // Zero offers is the ordinary state: the portal sees 2-3 a day, some days none. It is
    // reported rather than failed, because a red test here would mean "come back later",
    // which is not a fault anybody can act on.
    if (result.offers.length === 0) {
      report('no open offers right now — the parse assertion had nothing to run against;');
      report(`re-run when the board is not empty (deadlines read as ${STRAKER_DEADLINE_ZONE.id}).`);
      return;
    }

    for (const offer of result.offers) {
      // Throws `StrakerOfferShapeError` naming the field and the offer if the payload has
      // moved — which is the single most useful thing this whole file can tell anyone.
      const parsed = parseOffer(offer, { excludedLanguagePairs: [], logger: smokeLogger });

      expect(parsed.objId).toBe(offer.obj_id);
      expect(parsed.languageDirection).toMatch(/\S/);
      // Both are `number | null`, and a listed offer missing either is a failed contract
      // assumption rather than an ordinary skip (FR-023a) — so it is asserted, loudly.
      expect(parsed.effortWords, `offer ${parsed.objId} carried no readable word count`).not.toBe(
        null,
      );
      expect(parsed.deadlineMs, `offer ${parsed.objId} carried no readable deadline`).not.toBe(
        null,
      );

      const due =
        parsed.deadlineMs === null ? 'unreadable' : new Date(parsed.deadlineMs).toISOString();
      report(
        `${parsed.objId} · ${parsed.languageDirection} · ${parsed.effortWords ?? '?'} words · ` +
          `due ${due} (read as ${STRAKER_DEADLINE_ZONE.id})`,
      );
    }
  });

  it('reads the request budget the pacing rules depend on', () => {
    // `null` means unknown, which means the hard ceiling governs — never "unlimited"
    // (FR-019). Worth seeing on a supervised run: the headers disappearing is a contract
    // change the bot would otherwise only warn about in a log file.
    if (result.budget === null) {
      report('the portal reported no usable rate-limit headers — the hard ceiling governs.');
      return;
    }
    expect(result.budget.limit).toBeGreaterThan(0);
    expect(result.budget.remaining).toBeGreaterThanOrEqual(0);
    report(`budget ${result.budget.remaining}/${result.budget.limit} remaining`);
  });

  it('refuses to send a claim, even when handed one directly', async () => {
    // Layer 2, demonstrated. Nothing reaches the network: the guard throws first, so this
    // assertion is safe to run against the live portal and is exactly what makes the
    // "cannot claim" property a fact about the code rather than a promise in a comment.
    await expect(
      result.guardedFetch(`${result.cfg.baseUrl}${A_CLAIM_URL_SHAPE}`, { method: 'POST' }),
    ).rejects.toBeInstanceOf(LiveSmokeRefusal);

    // And the door the reader was given cannot POST anywhere at all.
    await expect(readOnlyClient({} as StrakerHttpClient).postJson('/anything', {})).rejects.toThrow(
      LiveSmokeRefusal,
    );
  });
});
