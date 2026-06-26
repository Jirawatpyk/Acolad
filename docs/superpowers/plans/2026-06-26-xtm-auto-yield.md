# XTM Auto-Yield Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the bot from ping-pong-fighting a human for the shared single-session XTM account: detect a competing login and yield (back off) instead of re-logging in, with a bounded escalation that pages on-call if the yield runs too long.

**Architecture:** The orchestration loop (`XtmPollLoop`) owns a 2-state machine (ACTIVE / YIELDING) persisted in the `meta` table. The portal client (`PlaywrightXtmClient`) becomes policy-free: on a logged-out page it reads `logout.jsp?type=…`, classifies it, and either re-logs in (default) or throws `SessionYieldError(kind)` when the loop's policy says yield. All yield decisions are pure functions (`runtime/yieldPolicy.ts`). Yield notifications reuse the existing standing-alert machinery (`raiseAlert`/`resolveAlert`), not hand-rolled outbox rows.

**Tech Stack:** Node.js 22, TypeScript strict (ESM, `.js` import specifiers), Playwright (Chromium), better-sqlite3, zod, pino, Vitest. Windows 11 / PowerShell 5.1.

## Global Constraints

- **TDD is mandatory** for `src/detection/`, `src/state/`, `src/reporting/`; write the test first, watch it FAIL, then implement. Coverage gate ≥ 80% on those three modules (`npm run test:coverage`).
- **ESM import specifiers end in `.js`** even for `.ts` sources (e.g. `import { x } from './yieldPolicy.js'`).
- **`npm run lint` and `npm run typecheck` must be 0-error** before any commit.
- **Outbox pattern**: every notification flows through the outbox; never send directly. System conditions use `raiseAlert`/`resolveAlert`.
- **Fail loud**: a yield is NOT a failure (heartbeat stays ok); a stuck yield IS escalated (heartbeat fail → page).
- **Single value `XTM_YIELD_WINDOW_MS`** is both the cooldown and the "recently authenticated" threshold; zod refine requires `XTM_YIELD_WINDOW_MS ≥ 3 × POLL_INTERVAL_MS`.
- **PowerShell 5.1**: no `&&`; chain with `;`. Run a single test file with `npx vitest run <path>`.
- **Deviations from design v2 (intentional refinements, see spec):** (1) yield paused/resumed use `raiseAlert`/`resolveAlert` triggers `xtm_yielding`/`yield_stuck` instead of hand-rolled `yield_paused:<id>` outbox rows — the standing-alert active-index gives correct per-episode dedup for free. (2) The probe runs a normal cycle (Malay auto-accept during a probe is desired behavior); stable-resume gates only the *resumed notification* + *episode reset*, not accept. (3) `yield_stuck` does NOT stop probing — it raises a critical alert + fails heartbeat each cycle while still probing every cooldown, so the bot auto-recovers if the human leaves.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/portal/errors.ts` | Portal error types | **Modify**: add `LogoutKind` type + `SessionYieldError` (extends `Error`, NOT `PortalError`) |
| `src/runtime/yieldPolicy.ts` | Pure yield decision functions | **Create** |
| `src/state/meta.ts` | Typed meta key/value access | **Modify**: 3 accessors (lastAuthSuccessMs, yieldUntilMs, yieldEpisodeStartedMs) |
| `src/config/index.ts` | zod config schema | **Modify**: 3 env vars + refine |
| `src/reporting/systemAlerts.ts` | System alert triggers | **Modify**: add `xtm_yielding` + `yield_stuck` triggers |
| `src/portal/xtmClient.ts` | Playwright I/O surface | **Modify**: `fetchJobSnapshot` takes a relogin policy; surfaces logout kind |
| `src/runtime/xtmPollLoop.ts` | Orchestration + yield state machine | **Modify**: yield gate, escalation, handleYield, stable-resume |
| `.env.example` | Config documentation | **Modify**: document 3 new vars |

Test files: `tests/unit/yieldPolicy.test.ts` (create), `tests/unit/meta.test.ts`, `tests/unit/config.test.ts`, `tests/unit/systemAlerts.test.ts` (create or extend), `tests/unit/xtmClient.test.ts`, `tests/integration/xtmPollLoop.test.ts`, `tests/integration/failureModes.xtm.test.ts`.

---

### Task 1: Logout types + pure yield policy

**Files:**
- Modify: `src/portal/errors.ts`
- Create: `src/runtime/yieldPolicy.ts`
- Create test: `tests/unit/yieldPolicy.test.ts`

**Interfaces:**
- Produces: `type LogoutKind = 'kicked_by_other' | 'expired' | 'unknown'` and `class SessionYieldError extends Error { readonly logoutKind: LogoutKind }` (in `errors.ts`); `classifyLogout(url: string): LogoutKind`, `shouldYieldOnLogout(a: { kind: LogoutKind; lastAuthSuccessMs: number; nowMs: number; windowMs: number }): boolean`, `inCooldown(yieldUntilMs: number, nowMs: number): boolean`, `yieldStuck(episodeStartedMs: number, nowMs: number, maxMinutes: number): boolean` (in `yieldPolicy.ts`).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/yieldPolicy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  classifyLogout,
  shouldYieldOnLogout,
  inCooldown,
  yieldStuck,
} from '../../src/runtime/yieldPolicy.js';

describe('classifyLogout', () => {
  it('detects a competing login from the logout.jsp type param', () => {
    expect(
      classifyLogout('https://xtm.acolad.com/project-manager-gui/logout.jsp?type=LOGGED_OFF_BY_ANOTHER_USER'),
    ).toBe('kicked_by_other');
  });
  it('detects a genuine session expiry', () => {
    expect(classifyLogout('https://xtm.acolad.com/project-manager-gui/logout.jsp?type=SESSION_EXPIRED')).toBe(
      'expired',
    );
  });
  it('is case-insensitive on the type value', () => {
    expect(classifyLogout('https://x/logout.jsp?type=logged_off_by_another_user')).toBe('kicked_by_other');
  });
  it('returns unknown for an unrecognised or missing type', () => {
    expect(classifyLogout('https://xtm.acolad.com/project-manager-gui/login.jsp')).toBe('unknown');
    expect(classifyLogout('')).toBe('unknown');
  });
});

describe('shouldYieldOnLogout', () => {
  const base = { lastAuthSuccessMs: 1_000_000, nowMs: 1_000_000 + 5_000, windowMs: 600_000 };
  it('always yields when kicked by another user (deterministic)', () => {
    expect(shouldYieldOnLogout({ ...base, kind: 'kicked_by_other' })).toBe(true);
  });
  it('yields on expiry only when authenticated within the window', () => {
    expect(shouldYieldOnLogout({ ...base, kind: 'expired' })).toBe(true); // 5s ago < 600s
  });
  it('does NOT yield on expiry when the last success is older than the window', () => {
    expect(
      shouldYieldOnLogout({ kind: 'expired', lastAuthSuccessMs: 1_000_000, nowMs: 2_000_000, windowMs: 600_000 }),
    ).toBe(false);
  });
  it('does NOT yield on a cold start (no prior success)', () => {
    expect(shouldYieldOnLogout({ kind: 'unknown', lastAuthSuccessMs: 0, nowMs: 5_000, windowMs: 600_000 })).toBe(
      false,
    );
  });
});

describe('inCooldown', () => {
  it('is true before the deadline, false at/after it', () => {
    expect(inCooldown(2_000, 1_999)).toBe(true);
    expect(inCooldown(2_000, 2_000)).toBe(false);
    expect(inCooldown(0, 1)).toBe(false); // 0 = not yielding
  });
});

describe('yieldStuck', () => {
  it('is true once the episode has run for >= maxMinutes', () => {
    expect(yieldStuck(0, 9_999_999, 60)).toBe(false); // episode 0 = not yielding
    expect(yieldStuck(1_000, 1_000 + 60 * 60_000 - 1, 60)).toBe(false);
    expect(yieldStuck(1_000, 1_000 + 60 * 60_000, 60)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/yieldPolicy.test.ts`
Expected: FAIL — cannot resolve `../../src/runtime/yieldPolicy.js`.

- [ ] **Step 3: Add `LogoutKind` + `SessionYieldError` to `src/portal/errors.ts`**

Append after the existing `PaginationDetectedError` (or anywhere among the error classes):

```ts
/** Why XTM logged a session out — read from `logout.jsp?type=…` (live recon). */
export type LogoutKind = 'kicked_by_other' | 'expired' | 'unknown';

/**
 * Thrown by the client when it lands logged-out and the loop's policy says to
 * YIELD rather than re-login (a competing human/session holds the shared account).
 * Deliberately extends Error (NOT PortalError): it is not a portal failure and
 * must never be swept into the portal_down / login-lockout handling.
 */
export class SessionYieldError extends Error {
  readonly kind = 'session_yield';
  constructor(readonly logoutKind: LogoutKind) {
    super(`yielding XTM account to another session (logout: ${logoutKind})`);
  }
}
```

- [ ] **Step 4: Create `src/runtime/yieldPolicy.ts`**

```ts
import type { LogoutKind } from '../portal/errors.js';

/**
 * Pure yield-decision helpers (no I/O — TDD, fully unit-tested). The loop owns
 * the yield state machine; these functions hold the rules. See
 * docs/superpowers/specs/2026-06-26-xtm-auto-yield-design.md.
 */

/** Read the logout reason from a `logout.jsp?type=…` URL (live-recon confirmed). */
export function classifyLogout(url: string): LogoutKind {
  if (/type=LOGGED_OFF_BY_ANOTHER_USER/i.test(url)) return 'kicked_by_other';
  if (/type=SESSION_EXPIRED/i.test(url)) return 'expired';
  return 'unknown';
}

/**
 * Should a logged-out page trigger a YIELD (vs a normal re-login)?
 * - kicked_by_other → always yield (deterministic: someone else logged in).
 * - expired/unknown → yield only if we were authenticated within `windowMs`
 *   (a suspiciously fast expiry implies a competing login burst); otherwise it
 *   is a genuine expiry and we should re-login.
 */
export function shouldYieldOnLogout(a: {
  kind: LogoutKind;
  lastAuthSuccessMs: number;
  nowMs: number;
  windowMs: number;
}): boolean {
  if (a.kind === 'kicked_by_other') return true;
  return a.lastAuthSuccessMs > 0 && a.nowMs - a.lastAuthSuccessMs < a.windowMs;
}

/** Still within the post-yield cooldown? (0 = not yielding.) */
export function inCooldown(yieldUntilMs: number, nowMs: number): boolean {
  return yieldUntilMs > nowMs;
}

/** Has the current yield episode exceeded the hard cap → escalate + page. */
export function yieldStuck(episodeStartedMs: number, nowMs: number, maxMinutes: number): boolean {
  return episodeStartedMs > 0 && nowMs - episodeStartedMs >= maxMinutes * 60_000;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/yieldPolicy.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck; npm run lint`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/portal/errors.ts src/runtime/yieldPolicy.ts tests/unit/yieldPolicy.test.ts
git commit -m "feat(runtime): pure yield policy + SessionYieldError/LogoutKind"
```

---

### Task 2: Meta accessors for yield state

**Files:**
- Modify: `src/state/meta.ts`
- Test: `tests/unit/meta.test.ts`

**Interfaces:**
- Consumes: existing `MetaStore.get/set/getNumber`.
- Produces: `meta.lastAuthSuccessMs: number`, `meta.setLastAuthSuccessMs(ms: number): void`, `meta.yieldUntilMs: number`, `meta.setYieldUntilMs(ms: number): void`, `meta.yieldEpisodeStartedMs: number`, `meta.setYieldEpisodeStartedMs(ms: number): void`. All default to `0` when unset.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/meta.test.ts` (create the file with this content if it does not exist; if it exists, append the `describe` block and reuse its DB-setup helper):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/state/db.js';
import { MetaStore } from '../../src/state/meta.js';

describe('MetaStore yield accessors', () => {
  let db: DB;
  let meta: MetaStore;
  beforeEach(() => {
    db = openDb(':memory:');
    meta = new MetaStore(db);
  });

  it('defaults all yield fields to 0 when unset', () => {
    expect(meta.lastAuthSuccessMs).toBe(0);
    expect(meta.yieldUntilMs).toBe(0);
    expect(meta.yieldEpisodeStartedMs).toBe(0);
  });

  it('round-trips each yield field', () => {
    meta.setLastAuthSuccessMs(1700000000000);
    meta.setYieldUntilMs(1700000600000);
    meta.setYieldEpisodeStartedMs(1700000000000);
    expect(meta.lastAuthSuccessMs).toBe(1700000000000);
    expect(meta.yieldUntilMs).toBe(1700000600000);
    expect(meta.yieldEpisodeStartedMs).toBe(1700000000000);
  });
});
```

> Note: confirm the DB open helper name. If `openDb` is not exported from `src/state/db.js`, use whatever the other tests in `tests/unit/` use to get a `DB` (grep `tests/unit/meta`-adjacent files for the in-memory setup) and mirror it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/meta.test.ts`
Expected: FAIL — `meta.lastAuthSuccessMs` is not a function/property.

- [ ] **Step 3: Add the accessors to `src/state/meta.ts`**

Insert before the closing brace of the `MetaStore` class (after `lastDailyReportDate`):

```ts
  // --- auto-yield state (ms epoch; 0 = unset/not-yielding) ---
  get lastAuthSuccessMs(): number {
    return this.getNumber('last_auth_success_ms', 0);
  }
  setLastAuthSuccessMs(ms: number): void {
    this.set('last_auth_success_ms', String(ms));
  }
  get yieldUntilMs(): number {
    return this.getNumber('yield_until_ms', 0);
  }
  setYieldUntilMs(ms: number): void {
    this.set('yield_until_ms', String(ms));
  }
  get yieldEpisodeStartedMs(): number {
    return this.getNumber('yield_episode_started_ms', 0);
  }
  setYieldEpisodeStartedMs(ms: number): void {
    this.set('yield_episode_started_ms', String(ms));
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/meta.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/meta.ts tests/unit/meta.test.ts
git commit -m "feat(state): meta accessors for auto-yield state"
```

---

### Task 3: Config — yield env vars + window/interval refine

**Files:**
- Modify: `src/config/index.ts`
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Produces: `cfg.XTM_YIELD_ENABLED: boolean`, `cfg.XTM_YIELD_WINDOW_MS: number`, `cfg.XTM_YIELD_MAX_MINUTES: number`. Schema rejects `XTM_YIELD_WINDOW_MS < 3 × POLL_INTERVAL_MS`.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/config.test.ts` (mirror the existing helper that builds a minimal valid env; reuse it as `validEnv()` — if the existing tests construct env inline, copy that object):

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

// A minimal env that passes the schema. If the test file already has such a
// helper, use it instead of redefining.
function validEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    XTM_ACOLAD_PORTAL_URL: 'https://xtm.example/login.jsp',
    XTM_ACOLAD_OFFERS_URL: 'https://xtm.example/offers',
    XTM_ACOLAD_Company: 'C',
    XTM_ACOLAD_Username: 'U',
    XTM_ACOLAD_Password: 'P',
    GOOGLE_SHEETS_ID: 'sheet',
    SHEETS_TAB_NAME: 'Tab',
    GOOGLE_CHAT_WEBHOOK_SYSTEM: 'https://chat.example/sys',
    GOOGLE_CHAT_WEBHOOK_TEAM: 'https://chat.example/team',
    HEALTHCHECKS_PING_URL: 'https://hc.example/ping',
    ...over,
  };
}

describe('auto-yield config', () => {
  it('defaults yield enabled, window 600000ms, max 60 min', () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.XTM_YIELD_ENABLED).toBe(true);
    expect(cfg.XTM_YIELD_WINDOW_MS).toBe(600_000);
    expect(cfg.XTM_YIELD_MAX_MINUTES).toBe(60);
  });

  it('can be disabled via XTM_YIELD_ENABLED=0', () => {
    expect(loadConfig(validEnv({ XTM_YIELD_ENABLED: '0' })).XTM_YIELD_ENABLED).toBe(false);
  });

  it('rejects a window smaller than 3x the poll interval (fail-fast)', () => {
    expect(() =>
      loadConfig(validEnv({ POLL_INTERVAL_MS: '20000', XTM_YIELD_WINDOW_MS: '40000' })),
    ).toThrow(/XTM_YIELD_WINDOW_MS/);
  });

  it('accepts a window exactly 3x the poll interval', () => {
    const cfg = loadConfig(validEnv({ POLL_INTERVAL_MS: '20000', XTM_YIELD_WINDOW_MS: '60000' }));
    expect(cfg.XTM_YIELD_WINDOW_MS).toBe(60_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: FAIL — `XTM_YIELD_ENABLED` is undefined; refine not present.

- [ ] **Step 3: Add the three vars to the schema in `src/config/index.ts`**

Inside the `z.object({ … })`, after the `DIAG` field (before the closing `})`):

```ts
  // --- auto-yield (shared-account session-collision back-off) ---
  XTM_YIELD_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== '0'), // default ON; only '0' disables
  XTM_YIELD_WINDOW_MS: z.coerce.number().int().positive().default(600_000),
  XTM_YIELD_MAX_MINUTES: z.coerce.number().int().positive().default(60),
```

- [ ] **Step 4: Add the cross-field refine**

Change the schema definition from `const schema = z.object({ … });` to chain a `.refine` (replace the line `export type AppConfig = z.infer<typeof schema>;` is unaffected — `schema` keeps the same name):

```ts
}).refine((c) => c.XTM_YIELD_WINDOW_MS >= 3 * c.POLL_INTERVAL_MS, {
  path: ['XTM_YIELD_WINDOW_MS'],
  message: 'XTM_YIELD_WINDOW_MS must be >= 3 x POLL_INTERVAL_MS (yield would otherwise be a no-op)',
});
```

i.e. the object literal's closing `})` becomes `}).refine(…);`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck; npm run lint`
Expected: 0 errors. (zod `.refine` on the object preserves `z.infer` typing.)

- [ ] **Step 7: Commit**

```bash
git add src/config/index.ts tests/unit/config.test.ts
git commit -m "feat(config): XTM_YIELD_* vars + window>=3x interval refine"
```

---

### Task 4: System alert triggers — `xtm_yielding` + `yield_stuck`

**Files:**
- Modify: `src/reporting/systemAlerts.ts`
- Test: `tests/unit/systemAlerts.test.ts` (create if absent, else extend)

**Interfaces:**
- Consumes: existing `raiseAlert(db, outbox, kind, occurredAt, detail)` / `resolveAlert(db, outbox, kind, occurredAt, downDuration)`.
- Produces: `TriggerKind` now includes `'xtm_yielding'` (warn, hasRecovered) and `'yield_stuck'` (critical, hasRecovered).

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/systemAlerts.test.ts` (reuse the file's existing DB+Outbox setup; if creating fresh, mirror another reporting test's setup):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/state/db.js';
import { createOutbox, Outbox } from '../../src/state/outbox.js';
import { raiseAlert, resolveAlert } from '../../src/reporting/systemAlerts.js';
import { loadConfig } from '../../src/config/index.js';

describe('yield alert triggers', () => {
  let db: DB;
  let outbox: Outbox;
  beforeEach(() => {
    db = openDb(':memory:');
    // Minimal cfg for createOutbox knobs (reuse the config test's validEnv if shared).
    const cfg = loadConfig({
      XTM_ACOLAD_PORTAL_URL: 'https://x/login.jsp',
      XTM_ACOLAD_OFFERS_URL: 'https://x/o',
      XTM_ACOLAD_Company: 'C',
      XTM_ACOLAD_Username: 'U',
      XTM_ACOLAD_Password: 'P',
      GOOGLE_SHEETS_ID: 's',
      SHEETS_TAB_NAME: 'T',
      GOOGLE_CHAT_WEBHOOK_SYSTEM: 'https://c/s',
      GOOGLE_CHAT_WEBHOOK_TEAM: 'https://c/t',
      HEALTHCHECKS_PING_URL: 'https://h/p',
    });
    outbox = createOutbox(db, cfg);
  });

  it('raises xtm_yielding once per active episode, then resolves', () => {
    expect(raiseAlert(db, outbox, 'xtm_yielding', '2026-06-26T00:00:00Z', 'account in use')).toBe(true);
    expect(raiseAlert(db, outbox, 'xtm_yielding', '2026-06-26T00:00:20Z', 'account in use')).toBe(false); // deduped
    expect(resolveAlert(db, outbox, 'xtm_yielding', '2026-06-26T00:10:00Z', '10 min')).toBe(true);
    // after resolve a new episode can raise again
    expect(raiseAlert(db, outbox, 'xtm_yielding', '2026-06-26T00:11:00Z', 'account in use')).toBe(true);
  });

  it('raises yield_stuck as a critical alert', () => {
    expect(raiseAlert(db, outbox, 'yield_stuck', '2026-06-26T01:00:00Z', 'paused 60 min')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/systemAlerts.test.ts`
Expected: FAIL — `'xtm_yielding'` not assignable to `TriggerKind`.

- [ ] **Step 3: Extend the `TriggerKind` union in `src/reporting/systemAlerts.ts`**

```ts
export type TriggerKind =
  | 'login_failed'
  | 'captcha'
  | 'layout_changed'
  | 'pagination'
  | 'portal_down'
  | 'outbox_dead'
  | 'cold_start_repeat'
  | 'db_corrupt'
  | 'accept_failed'
  | 'daily_report_dead'
  | 'xtm_yielding'
  | 'yield_stuck';
```

- [ ] **Step 4: Add the two `TRIGGERS` entries**

Add inside the `TRIGGERS` record (after `daily_report_dead`):

```ts
  xtm_yielding: {
    severity: 'warn',
    title: 'Bot paused — XTM account in use',
    impact: 'Monitoring is paused while a teammate (or another session) uses the shared account',
    action:
      'No action needed if a teammate is working in XTM; the bot retries automatically and resumes when the account is free',
    hasRecovered: true,
  },
  yield_stuck: {
    severity: 'critical',
    title: 'Bot paused too long — account still in use',
    impact: 'Monitoring has been paused past the limit; new jobs are not being auto-accepted',
    action:
      'Confirm a teammate is actually using XTM. If not, free the account (log out) or disable the bot (set XTM_YIELD_ENABLED=0 then npm run deploy)',
    hasRecovered: true,
  },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/systemAlerts.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint, then commit**

Run: `npm run typecheck; npm run lint`

```bash
git add src/reporting/systemAlerts.ts tests/unit/systemAlerts.test.ts
git commit -m "feat(reporting): xtm_yielding + yield_stuck alert triggers"
```

---

### Task 5: Client surfaces logout kind + honours a relogin policy

**Files:**
- Modify: `src/portal/xtmClient.ts`
- Test: `tests/unit/xtmClient.test.ts`

**Interfaces:**
- Consumes: `classifyLogout` (Task 1), `SessionYieldError`/`LogoutKind` (Task 1), existing `XtmOps`.
- Produces: `XtmPortalClient.fetchJobSnapshot(pollCycleId: string, opts?: { decideRelogin?: (kind: LogoutKind) => boolean }): Promise<XtmJobSnapshot>`. When `decideRelogin(kind)` returns `false` on a logged-out page, the client throws `SessionYieldError(kind)` instead of logging in. Default (no opts) preserves the old always-relogin behavior.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/xtmClient.test.ts` (this file already stubs `XtmOps` — reuse its harness; the snippet below shows the two new cases and the shape of the stub it needs):

```ts
import { describe, it, expect } from 'vitest';
import { SessionYieldError } from '../../src/portal/errors.js';
// ...reuse the file's existing imports + makeClient/stub helpers...

describe('fetchJobSnapshot relogin policy', () => {
  it('throws SessionYieldError (no login) when policy declines relogin on a logged-out page', async () => {
    let loginCalls = 0;
    // Stub ops: report logged-out, and the page.url() resolves to a kicked logout.
    const client = makeClientWith({
      isLoggedOut: async () => true,
      login: async () => {
        loginCalls++;
      },
      readActiveOnce: async () => ({ jobs: [], malformed: [], capturedAt: 'x', pollCycleId: 'p' }),
      pageUrl: 'https://xtm/logout.jsp?type=LOGGED_OFF_BY_ANOTHER_USER',
    });
    await expect(
      client.fetchJobSnapshot('p', { decideRelogin: () => false }),
    ).rejects.toBeInstanceOf(SessionYieldError);
    expect(loginCalls).toBe(0); // never logged in → never kicked the human
  });

  it('logs in normally when policy allows relogin (default behavior)', async () => {
    let loginCalls = 0;
    const client = makeClientWith({
      isLoggedOut: async () => true,
      login: async () => {
        loginCalls++;
      },
      readActiveOnce: async () => ({ jobs: [], malformed: [], capturedAt: 'x', pollCycleId: 'p' }),
      pageUrl: 'https://xtm/logout.jsp?type=SESSION_EXPIRED',
    });
    const snap = await client.fetchJobSnapshot('p'); // no opts → always relogin
    expect(loginCalls).toBe(1);
    expect(snap.jobs).toEqual([]);
  });
});
```

> The existing `xtmClient.test.ts` constructs a `PlaywrightXtmClient` with a fake `browser` whose `page()` returns a stub `Page`. Extend that stub so `page.url()` returns the `pageUrl` above. Add a `makeClientWith` helper if one is not already present, mirroring the file's current construction.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/xtmClient.test.ts`
Expected: FAIL — `fetchJobSnapshot` ignores the policy / never throws `SessionYieldError`.

- [ ] **Step 3: Update the interface + imports in `src/portal/xtmClient.ts`**

Add imports near the existing error imports:

```ts
import { SessionYieldError, type LogoutKind } from './errors.js';
import { classifyLogout } from '../runtime/yieldPolicy.js';
```

Change the interface method signature in `XtmPortalClient`:

```ts
  fetchJobSnapshot(
    pollCycleId: string,
    opts?: { decideRelogin?: (kind: LogoutKind) => boolean },
  ): Promise<XtmJobSnapshot>;
```

- [ ] **Step 4: Rewrite `fetchJobSnapshot` to consult the policy**

Replace the existing method body with:

```ts
  async fetchJobSnapshot(
    pollCycleId: string,
    opts?: { decideRelogin?: (kind: LogoutKind) => boolean },
  ): Promise<XtmJobSnapshot> {
    // Default: always relogin (preserves pre-yield behavior + existing tests).
    const decideRelogin = opts?.decideRelogin ?? ((): boolean => true);
    const page = await this.browser.page();
    await this.navigateToInbox(page);
    if (await this.ops.isLoggedOut(page)) {
      const kind = classifyLogout(page.url());
      if (!decideRelogin(kind)) throw new SessionYieldError(kind);
      await this.login(page);
      await this.navigateToInbox(page);
    }
    try {
      return await this.ops.readActiveOnce(page, pollCycleId);
    } catch (err) {
      const classified =
        err instanceof LayoutChangedError ||
        err instanceof PaginationDetectedError ||
        err instanceof CaptchaDetectedError;
      let loggedOut = false;
      if (!classified) {
        try {
          loggedOut = await this.ops.isLoggedOut(page);
        } catch {
          throw err; // probe itself failed → preserve the ORIGINAL classification
        }
      }
      if (err instanceof SessionExpiredError || loggedOut) {
        const kind = classifyLogout(page.url());
        if (!decideRelogin(kind)) throw new SessionYieldError(kind);
        await this.login(page);
        await this.navigateToInbox(page);
        return this.ops.readActiveOnce(page, pollCycleId);
      }
      throw err;
    }
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/xtmClient.test.ts`
Expected: PASS (new cases + all pre-existing cases still green).

- [ ] **Step 6: Typecheck + lint, then commit**

Run: `npm run typecheck; npm run lint`

```bash
git add src/portal/xtmClient.ts tests/unit/xtmClient.test.ts
git commit -m "feat(portal): fetchJobSnapshot relogin policy via logout kind"
```

---

### Task 6: Loop yield state machine (gate, escalation, handleYield, stable-resume)

**Files:**
- Modify: `src/runtime/xtmPollLoop.ts`
- Test: `tests/integration/xtmPollLoop.test.ts`, `tests/integration/failureModes.xtm.test.ts`

**Interfaces:**
- Consumes: `inCooldown`, `yieldStuck`, `shouldYieldOnLogout` (Task 1); `SessionYieldError`, `LogoutKind` (Task 1); meta accessors (Task 2); `cfg.XTM_YIELD_*` (Task 3); `raiseAlert`/`resolveAlert` triggers (Task 4); `fetchJobSnapshot(id, { decideRelogin })` (Task 5).
- Produces: no new public surface — `runOnce()` keeps returning `Promise<boolean>` (true = healthy cycle incl. a quiet yield; false = lockout / stuck-yield / error).

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/xtmPollLoop.test.ts` (reuse the file's stub-client + in-memory-DB harness; the stub client's `fetchJobSnapshot` must accept the 2nd `opts` arg and be scriptable to throw `SessionYieldError`):

```ts
import { SessionYieldError } from '../../src/portal/errors.js';
// ...reuse existing harness (makeLoop, stubClient, fakeClock, fakeHeartbeat, db)...

describe('auto-yield', () => {
  it('enters YIELDING on a kicked logout: no error escalation, heartbeat ok, paused alert once', async () => {
    // clock at T0; lastAuthSuccess fresh so policy would yield, but kicked is deterministic anyway
    stubClient.fetchJobSnapshot = async () => {
      throw new SessionYieldError('kicked_by_other');
    };
    const ok = await loop.runOnce();
    expect(ok).toBe(true); // a quiet yield is healthy
    expect(heartbeat.failCount).toBe(0);
    expect(heartbeat.okCount).toBe(1);
    // 'xtm_yielding' alert enqueued exactly once
    expect(outboxRows(db).filter((r) => r.event_id.startsWith('system'))).toHaveLength(1);
    // meta marks the episode + cooldown
    const meta = new MetaStore(db);
    expect(meta.yieldEpisodeStartedMs).toBeGreaterThan(0);
    expect(meta.yieldUntilMs).toBeGreaterThan(0);
  });

  it('skips the read during cooldown but still flushes the outbox', async () => {
    const meta = new MetaStore(db);
    meta.setYieldEpisodeStartedMs(clock.nowMs());
    meta.setYieldUntilMs(clock.nowMs() + 600_000); // far future → in cooldown
    let fetched = 0;
    stubClient.fetchJobSnapshot = async () => {
      fetched++;
      return emptySnapshot();
    };
    const ok = await loop.runOnce();
    expect(ok).toBe(true);
    expect(fetched).toBe(0); // never touched the portal
    expect(dispatcherFlushCount).toBeGreaterThan(0); // but DID flush
    expect(heartbeat.okCount).toBe(1);
  });

  it('escalates to yield_stuck + heartbeat.fail once the episode exceeds the cap', async () => {
    const meta = new MetaStore(db);
    meta.setYieldEpisodeStartedMs(clock.nowMs() - 61 * 60_000); // 61 min ago
    meta.setYieldUntilMs(clock.nowMs() + 600_000); // still cooling down
    const ok = await loop.runOnce();
    expect(ok).toBe(false); // stuck = not healthy
    expect(heartbeat.failCount).toBe(1);
    const critical = outboxRows(db).find((r) => r.payload_json.includes('paused too long'));
    expect(critical).toBeTruthy();
  });

  it('resumes only after RESUME_STABLE_CYCLES consecutive successful reads', async () => {
    const meta = new MetaStore(db);
    meta.setYieldEpisodeStartedMs(clock.nowMs() - 5_000);
    meta.setYieldUntilMs(0); // cooldown elapsed → probe allowed
    meta.setLastAuthSuccessMs(clock.nowMs() - 5_000);
    stubClient.fetchJobSnapshot = async () => emptySnapshot();
    await loop.runOnce(); // probe #1: still tentative, episode not cleared
    expect(new MetaStore(db).yieldEpisodeStartedMs).toBeGreaterThan(0);
    await loop.runOnce(); // probe #2: stable → resume
    expect(new MetaStore(db).yieldEpisodeStartedMs).toBe(0);
    expect(new MetaStore(db).yieldUntilMs).toBe(0);
  });

  it('is a no-op path when XTM_YIELD_ENABLED=0 (always relogins, never yields)', async () => {
    const loopOff = makeLoop({ XTM_YIELD_ENABLED: false }); // helper override
    stubClient.fetchJobSnapshot = async (_id, opts) => {
      expect(opts).toBeUndefined(); // no policy passed when disabled
      return emptySnapshot();
    };
    expect(await loopOff.runOnce()).toBe(true);
  });
});
```

And in `tests/integration/failureModes.xtm.test.ts`:

```ts
it('SessionYieldError does not count as a login failure or portal_down', async () => {
  stubClient.fetchJobSnapshot = async () => {
    throw new SessionYieldError('kicked_by_other');
  };
  await loop.runOnce();
  await loop.runOnce();
  // never raises login_failed / portal_down, never enters lockout
  expect(outboxRows(db).some((r) => r.payload_json.includes('Login failed'))).toBe(false);
  expect(outboxRows(db).some((r) => r.payload_json.includes('Portal unreachable'))).toBe(false);
});
```

> Adapt helper names (`outboxRows`, `dispatcherFlushCount`, `emptySnapshot`, `makeLoop`) to whatever the existing test files expose. If the stub client's `fetchJobSnapshot` currently takes one arg, widen it to `(id, opts?)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/xtmPollLoop.test.ts tests/integration/failureModes.xtm.test.ts`
Expected: FAIL — yield branches not implemented.

- [ ] **Step 3: Add imports + constant + field to `src/runtime/xtmPollLoop.ts`**

Add to the imports:

```ts
import { SessionYieldError } from '../portal/errors.js';
import { inCooldown, yieldStuck, shouldYieldOnLogout } from './yieldPolicy.js';
```

(`SessionYieldError` may be added to the existing `../portal/errors.js` import group. `raiseAlert` is already imported indirectly — ensure `raiseAlert` and `resolveAlert` from `../reporting/systemAlerts.js` are imported; they already are.)

Add a module constant near `PORTAL_DOWN_THRESHOLD_MS`:

```ts
/** Consecutive clean reads required after a yield before declaring full resume. */
const RESUME_STABLE_CYCLES = 2;
```

Add a private field near `loginFailures`:

```ts
  private consecutiveActiveCycles = 0;
```

- [ ] **Step 4: Add a shared flush+heartbeat helper**

Add this private method to the class (it factors the cooldown path's flush/dead-gate/heartbeat; `forceFail` lets the stuck path page):

```ts
  /** Flush the outbox and set heartbeat ok/fail by the dead-backlog gate (or forceFail). */
  private async flushAndHeartbeat(forceFail: boolean): Promise<void> {
    this.nonTeamFailureThisFlush = false;
    await this.dispatcher.flush(this.clock.nowIso(), this.clock.nowMs());
    const stuck =
      forceFail || this.nonTeamFailureThisFlush || this.outbox.countDeadExcludingChannel('team') > 0;
    if (stuck) {
      await this.heartbeat.fail();
    } else {
      resolveAlert(this.db, this.outbox, 'outbox_dead', this.clock.nowIso(), 'notifications delivering normally');
      await this.heartbeat.ok();
    }
  }
```

- [ ] **Step 5: Add the yield gate at the top of `runOnce()`**

Immediately after the existing lockout block (after its `return false;`/closing brace, before `const pollCycleId = randomUUID();`):

```ts
    // --- auto-yield gate (shared-account session collision) ---
    if (this.cfg.XTM_YIELD_ENABLED) {
      const yNow = this.clock.nowMs();
      const stuck = yieldStuck(this.meta.yieldEpisodeStartedMs, yNow, this.cfg.XTM_YIELD_MAX_MINUTES);
      if (stuck) {
        // Louder escalation (deduped) — but DO NOT stop probing: still fall through so the
        // bot retries each cooldown and auto-recovers if the human leaves.
        const min = Math.round((yNow - this.meta.yieldEpisodeStartedMs) / 60_000);
        raiseAlert(
          this.db,
          this.outbox,
          'yield_stuck',
          this.clock.nowIso(),
          `bot paused ${min} min — confirm a teammate is using XTM, or free the account / disable the bot`,
        );
      }
      if (inCooldown(this.meta.yieldUntilMs, yNow)) {
        this.logger.info(
          { module: 'xtmPollLoop', action: 'yield', outcome: 'cooldown', stuck },
          'yielding to another XTM session (cooldown)',
        );
        await this.flushAndHeartbeat(stuck);
        return !stuck;
      }
    }
```

- [ ] **Step 6: Wire the relogin policy into the fetch + add stable-resume**

Replace the existing `const snapshot = await this.client.fetchJobSnapshot(pollCycleId);` line with:

```ts
      // A post-cooldown PROBE (episode active + not yet retaken this episode, i.e.
      // consecutiveActiveCycles === 0) MUST force a relogin to retake the account.
      // Without this, the kicked_by_other policy (always-yield) would refuse to
      // relogin forever and the bot could never resume. After the probe retakes
      // (consecutiveActiveCycles >= 1) we fall back to the normal yield-on-kick policy.
      const probing =
        this.cfg.XTM_YIELD_ENABLED &&
        this.meta.yieldEpisodeStartedMs > 0 &&
        this.consecutiveActiveCycles === 0;
      const decideRelogin = this.cfg.XTM_YIELD_ENABLED
        ? (kind: LogoutKind): boolean =>
            probing ||
            !shouldYieldOnLogout({
              kind,
              lastAuthSuccessMs: this.meta.lastAuthSuccessMs,
              nowMs: this.clock.nowMs(),
              windowMs: this.cfg.XTM_YIELD_WINDOW_MS,
            })
        : undefined;
      const snapshot = await this.client.fetchJobSnapshot(
        pollCycleId,
        decideRelogin ? { decideRelogin } : undefined,
      );
      this.meta.setLastAuthSuccessMs(this.clock.nowMs());
      if (this.cfg.XTM_YIELD_ENABLED && this.meta.yieldEpisodeStartedMs > 0) {
        this.consecutiveActiveCycles += 1;
        if (this.consecutiveActiveCycles >= RESUME_STABLE_CYCLES) {
          const min = Math.round((this.clock.nowMs() - this.meta.yieldEpisodeStartedMs) / 60_000);
          resolveAlert(this.db, this.outbox, 'xtm_yielding', this.clock.nowIso(), `${min} min`);
          resolveAlert(this.db, this.outbox, 'yield_stuck', this.clock.nowIso(), `${min} min`);
          this.db.transaction(() => {
            this.meta.setYieldUntilMs(0);
            this.meta.setYieldEpisodeStartedMs(0);
          })();
          this.consecutiveActiveCycles = 0;
          this.logger.info(
            { module: 'xtmPollLoop', action: 'yield', outcome: 'resumed' },
            'resumed XTM monitoring',
          );
        }
      }
```

Add the `LogoutKind` type import to the errors import group:

```ts
import {
  CaptchaDetectedError,
  LayoutChangedError,
  LoginFailedError,
  PaginationDetectedError,
  SessionYieldError,
  type LogoutKind,
} from '../portal/errors.js';
```

- [ ] **Step 7: Catch `SessionYieldError` before `handleError`**

Change the bottom `catch (err)` of `runOnce()`:

```ts
    } catch (err) {
      if (err instanceof SessionYieldError) {
        await this.handleYield(err);
        return true; // a yield is a healthy, expected state — not an error
      }
      await this.handleError(err);
      return false;
    }
```

- [ ] **Step 8: Add `handleYield`**

Add this private method:

```ts
  /**
   * Enter (or extend) a yield episode. raiseAlert runs BEFORE the meta writes so a
   * crash between them is self-healing: on restart the episode is unset → firstEntry
   * is true again → raiseAlert re-fires but the active-alert dedup drops the duplicate,
   * and the meta gets set on the retry. No nested transaction needed.
   */
  private async handleYield(err: SessionYieldError): Promise<void> {
    const nowMs = this.clock.nowMs();
    const nowIso = this.clock.nowIso();
    this.consecutiveActiveCycles = 0;
    const firstEntry = this.meta.yieldEpisodeStartedMs === 0;
    // A re-yield while already past the hard cap must keep paging (not silently flip
    // heartbeat back to ok). firstEntry can never be stuck (episode just started).
    const stuck =
      !firstEntry &&
      yieldStuck(this.meta.yieldEpisodeStartedMs, nowMs, this.cfg.XTM_YIELD_MAX_MINUTES);
    if (firstEntry) {
      const windowMin = Math.round(this.cfg.XTM_YIELD_WINDOW_MS / 60_000);
      raiseAlert(
        this.db,
        this.outbox,
        'xtm_yielding',
        nowIso,
        `XTM account in use by another session (logout: ${err.logoutKind}) — monitoring paused, retrying ~every ${windowMin} min`,
      );
    }
    this.db.transaction(() => {
      this.meta.setYieldUntilMs(nowMs + this.cfg.XTM_YIELD_WINDOW_MS);
      if (firstEntry) this.meta.setYieldEpisodeStartedMs(nowMs);
    })();
    this.logger.info(
      { module: 'xtmPollLoop', action: 'yield', outcome: 'paused', kind: err.logoutKind, stuck },
      'yielded XTM account to another session',
    );
    await this.flushAndHeartbeat(stuck); // healthy unless the outbox is dead OR past the cap
  }
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/xtmPollLoop.test.ts tests/integration/failureModes.xtm.test.ts`
Expected: PASS.

- [ ] **Step 10: Full suite + coverage + typecheck + lint**

Run: `npm run typecheck; npm run lint; npm run test:coverage`
Expected: all green; `state/` coverage ≥ 80%.

- [ ] **Step 11: Commit**

```bash
git add src/runtime/xtmPollLoop.ts tests/integration/xtmPollLoop.test.ts tests/integration/failureModes.xtm.test.ts
git commit -m "feat(runtime): auto-yield state machine in the poll loop"
```

---

### Task 7: Document env vars + final verification

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Document the three vars in `.env.example`**

Add a section (match the file's existing comment style):

```bash
# --- Auto-yield: back off when a human/another session uses the shared XTM account ---
# The bot and the team share ONE XTM login that allows only one session at a time.
# When the bot detects it was logged off by another user it yields instead of
# re-logging in (which would kick the human). Set to 0 to disable (e.g. once the
# bot has its OWN XTM account).
XTM_YIELD_ENABLED=1
# Cooldown between yield re-probes AND the "recently authenticated" threshold.
# MUST be >= 3 x POLL_INTERVAL_MS or the bot refuses to start.
XTM_YIELD_WINDOW_MS=600000
# Hard cap: if the bot stays yielded this long it raises a critical alert and pages
# on-call (a teammate may have left a session open, or XTM may be stuck).
XTM_YIELD_MAX_MINUTES=60
```

- [ ] **Step 2: Full verification gate**

Run: `npm run lint; npm run typecheck; npm run test:coverage`
Expected: 0 lint errors, 0 type errors, all tests pass, detection/state/reporting coverage ≥ 80%.

- [ ] **Step 3: Smoke the config fail-fast manually**

Run (PowerShell): `$env:XTM_YIELD_WINDOW_MS='1000'; npm run poll:once`
Expected: the process refuses to start with `XTM_YIELD_WINDOW_MS must be >= 3 x POLL_INTERVAL_MS`. Then clear it: `Remove-Item Env:\XTM_YIELD_WINDOW_MS`.

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "docs(env): document XTM_YIELD_* auto-yield knobs"
```

---

## Self-Review

**1. Spec coverage (design v2 §4–§12):**
- §4 state machine → Task 6 (gate, handleYield, stable-resume, escalation). ✓
- §5 pure functions (classifyLogout/shouldYieldOnLogout/inCooldown/yieldStuck) → Task 1. ✓
- §6 touch points: errors → T1; yieldPolicy → T1; meta → T2; xtmClient → T5; xtmPollLoop → T6; config → T3. ✓
- §7 flow (escalation/cooldown-flush/decideRelogin/txn/catch) → Task 6 steps 5–8. ✓
- §8 notifications + heartbeat → Task 4 (triggers) + Task 6 (raise/resolve, heartbeat ok/fail). **Refinement:** uses `raiseAlert`/`resolveAlert` instead of episode-scoped `enqueue` (better dedup); documented in Global Constraints. ✓
- §9 edge cases: cold start (T1 shouldYieldOnLogout lastAuth=0), restart (meta persistence T2), AFK→escalate (T6 yield_stuck), expired-stale→relogin (T1+T5). ✓
- §10 kill switch (XTM_YIELD_ENABLED=0) → T3 + T6 no-op path test. ✓
- §11 config + refine → T3. ✓
- §12 test plan → tests in T1–T6. ✓

**2. Placeholder scan:** No TBD/TODO. Every code step shows complete code. The only soft spots are explicit "reuse the existing test harness / adapt helper names" notes — these are real instructions (the test files already have harnesses), not placeholders, and each lists the exact behavior the helper must provide.

**3. Type consistency:** `LogoutKind` (errors.ts) used identically in yieldPolicy, xtmClient, xtmPollLoop. `decideRelogin: (kind: LogoutKind) => boolean` matches between Task 5 (interface) and Task 6 (caller). `shouldYieldOnLogout` arg object shape matches T1 definition and T6 call. Meta accessor names (`lastAuthSuccessMs`/`yieldUntilMs`/`yieldEpisodeStartedMs` + setters) match between T2 and T6. Trigger kinds `xtm_yielding`/`yield_stuck` match between T4 and T6.

**Open (non-blocking, tracked in spec §3/§13):** measure XTM real session timeout to confirm the window upper bound; pursue separate bot account (design A).
