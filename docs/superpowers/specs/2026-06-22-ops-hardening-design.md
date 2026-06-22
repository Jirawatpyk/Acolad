# Ops Hardening — single-instance safety, safe deploy, reboot survival

**Date:** 2026-06-22
**Feature branch:** 002-xtm-detect-accept
**Status:** Approved (brainstorming) — revised after reliability-engineer spec review (3 critical + 4 important resolved)

## 1. Problem & goals

`acolad-bot` runs 24/7 under PM2 (fork mode) on Windows 11, polling a SHARED XTM
account every ~20s and now AUTO-ACCEPTING Malay jobs (irreversible). The code path is
hardened (2 review rounds), but the **operational layer around it is fragile** — and on a
shared account those gaps are the largest remaining risk:

1. **No single-instance guard.** Repeated `pm2 restart` has left the old
   ProcessContainerFork alive (its Playwright Chromium child kept it up), so two pollers
   ran concurrently while PM2 tracked only one → double portal request-rate (FR-011 cap is
   per-account but enforced per-process → silently exceeded → account-suspension risk) and
   concurrent accepts.
2. **Orphan root cause = a cycle that cannot be cancelled mid-flight.** `main.ts`'s SIGTERM
   handler only sets `running=false`, and the loop checks that flag ONLY at the top — so a
   SIGTERM mid-cycle cannot interrupt `loop.runOnce()` (which can exceed 33s: 30s nav + 15s
   settle + 20s iframe + 20s marker + 15s/row accept + browser recycle). PM2's default
   `kill_timeout` (1.6s) then SIGKILLs before shutdown completes → the Chromium child is orphaned.
3. **No reboot survival without a logged-on session.** `pm2-windows-startup` is configured,
   but `AutoAdminLogon=0`, so an overnight Windows-Update reboot stops the bot until a human
   logs in. Jobs arrive ~4-5/day with a <1-min snatch window → silent downtime = missed jobs.
4. **Manual, footgun-prone deploy.** `build` → `pm2 restart` is exactly the step that orphans.
5. **Downtime not promptly detected.** Healthchecks period/grace not tuned to the 20s poll.

**Goal:** guarantee at most one poller ever runs, make shutdown bounded + deploys clean,
survive reboots, and detect every downtime path within minutes — without rewriting the
runtime or dropping PM2.

## 2. Decisions

- **Single-instance mechanism: port-bind.** OS-managed (port frees on process death → no
  stale-lock handling), cross-platform, zero new deps (`node:net`).
- **Bounded shutdown is in scope (NOT "verify only").** The orphan root cause is fixed at its
  source: SIGTERM triggers a *bounded* shutdown (force-dispose watchdog + a dispose timeout)
  so the process always exits within `SHUTDOWN_BUDGET + DISPOSE_TIMEOUT` regardless of cycle
  length. `kill_timeout` is only a final backstop, not the primary mechanism.
- **Reboot survival: auto-logon + existing PM2 startup.** Minimal; uses what's configured.
  Trade-off accepted (dedicated, physically-secured bot box); credential via Sysinternals
  Autologon's LSA-secret storage (not plaintext registry). Healthchecks is the detection net
  for every way reboot-survival can silently fail (see §3.4).
- **Deploy as PowerShell** (`scripts/deploy.ps1`); `pm2 restart` by hand is DISALLOWED (§3.3).
- **Tunables (reconciled so they don't fight each other):**
  | name | value | constraint |
  |---|---|---|
  | `SINGLE_INSTANCE_PORT` | 47811 (config) | configurable if it ever clashes |
  | `SHUTDOWN_BUDGET_MS` | 25_000 | watchdog: force shutdown if the loop hasn't exited |
  | `DISPOSE_TIMEOUT_MS` | 8_000 | cap on `browser.dispose()` (Promise.race) |
  | PM2 `kill_timeout` | 35_000 | > 25 + 8 = 33 (backstop only) |
  | lock bind-retry window | 45_000 | **≥ kill_timeout + margin** (so a new instance waits out the old's max shutdown — fixes C2) |
  | Healthchecks period / grace | 60s / 300s | downtime paged within ~5 min |
  | deploy verify timeout | 90_000 | ≥ worst-case cold-start cycle (not 30s) |

## 3. Components

### 3.1 F1 — Single-instance lock (`src/runtime/singleInstance.ts`)

- **Interface:** `acquireSingleInstanceLock(opts: { port: number; retryMs: number; onRefused?: () => Promise<void>; logger?: Logger }): Promise<() => Promise<void>>`
  - Resolves with an async `release()` when this process owns the lock.
  - On failure: awaits `onRefused()` (used to ping Healthchecks /fail — see C3), then rejects.
- **Behavior:** `net.createServer()` that destroys any incoming socket (sentinel) → `.listen(port, '127.0.0.1')`.
  - success → sole instance; keep the server ref; `release = () => promisify(server.close)()`.
  - `EADDRINUSE` → retry every 500ms for `retryMs` (45_000). Still in use → reject.
  - other listen error → reject (fail loud).
- **Wiring & ordering:** in `main.ts`, BEFORE `createXtmBot()` but AFTER `loadConfig()` (so the
  Healthchecks URL is available for the refusal ping). On rejection: ping Healthchecks /fail,
  log loud (`module: 'singleInstance', outcome: 'refused'`), `console.error` a human line,
  `process.exit(1)`.
- **C3 — refusal must page someone, not just show errored in `pm2 status`.** The refusal
  happens before the outbox/heartbeat exist, and nobody watches `pm2 status`. So the lock
  pings `HEALTHCHECKS_PING_URL + '/fail'` directly (the heartbeat is just a fetch — reuse it)
  before exit, so the dead-man switch fires within grace 300s. The error message must
  distinguish "another acolad instance" (sentinel responds) from "a foreign process holds the
  port" and log the holder PID (`Get-NetTCPConnection -LocalPort 47811`) for the runbook.
- **Config:** add `SINGLE_INSTANCE_PORT` (zod int, default 47811).
- **`once.ts` (poll:once):** also acquires the lock and refuses if held — single-instance is a
  safety invariant on a shared account where `ACCEPT_ENABLED=1` (a concurrent `poll:once` could
  double-accept). Documented: **stop the bot before `poll:once`** (already the norm). Diag
  scripts (`scripts/diag-*.ts`, `verify-*.mjs`) stay "stop the bot first".

### 3.2 Bounded graceful shutdown + PM2 hardening (CODE CHANGE — `main.ts`, `browser.ts`, `ecosystem.config.cjs`)

The reliability review showed the prior "verify only" assumption was false. Required changes:

- **`main.ts` SIGTERM path:** first SIGTERM → `running=false` AND arm a watchdog
  `setTimeout(forceShutdown, SHUTDOWN_BUDGET_MS)`. A second SIGTERM → `forceShutdown()` now.
  `forceShutdown()` = `await disposeWithTimeout(client); db.close(); release(); process.exit(0)`
  — it does NOT wait for the in-flight cycle (disposing the browser mid-cycle just errors the
  in-flight Playwright calls, which are already caught). The normal loop-exit path clears the
  watchdog and runs the same bounded dispose. Whichever fires first wins.
- **`browser.ts` `dispose()`:** wrap the close in `Promise.race([close(), timeout(DISPOSE_TIMEOUT_MS)])`
  so a hung Chromium `context.close()` cannot block shutdown forever.
  > **Implementation note (deviation):** the "best-effort kill the browser process tree if still
  > alive" step is **deferred**. `chromium.launch()` does not expose the browser PID (that lives on
  > `BrowserServer.process()` via `launchServer()`+`connect()`, a lifecycle refactor of the
  > crash-recovery-critical `browser.ts` not worth the risk in a hardening pass). Current posture: a
  > timed-out dispose is **logged loudly** (`main.ts` `outcome: 'dispose_timeout'`) and the leftover
  > Chromium is reaped by the next `npm run deploy` orphan-sweep. Tracked as a follow-up.
- **`ecosystem.config.cjs`:** add `kill_timeout: 35000` (backstop > 25 + 8). Result: the process
  always exits ≤ ~33s after SIGTERM, before SIGKILL → **no orphaned Chromium** regardless of cycle length.
- **Stretch (out of scope for v1, noted):** thread an `AbortSignal` from SIGTERM into `runOnce()`'s
  Playwright actions for true cooperative cancellation — would make `kill_timeout` purely vestigial.
  v1 uses the watchdog (cheaper, deterministic enough).

### 3.3 F2 — Deploy script (`scripts/deploy.ps1`, `npm run deploy`)

One command, single-instance-safe, idempotent. **`pm2 restart` by hand is disallowed — always `npm run deploy`** (a bare restart skips the stop-and-wait and re-opens the C2 race).

1. `npm run build`
2. `pm2 stop acolad-bot` → poll until the process is gone AND port 47811 is free (≤45s, ≥ kill_timeout).
3. Targeted orphan sweep (robust):
   - kill any node whose **normalized absolute** `pm_exec_path`/command line == acolad's `dist/runtime/main.js` and is NOT the pm2-tracked pid (handle Windows slash/case).
   - kill Chromium whose `--user-data-dir` points at acolad's `state` dir — this matches even a
     TRUE orphan whose parent node already died, and NEVER a broad `ms-playwright` sweep (that hit AutoRWS).
4. `pm2 start ecosystem.config.cjs` + `pm2 save` + assert the dump now contains `acolad-bot`.
5. Verify (timeout 90s — cold start can exceed 30s): a `poll cycle ok` log line appears (PRIMARY,
   local, fast) AND single ProcessContainerFork; Healthchecks green is SECONDARY (has propagation
   delay). Print PASS/FAIL; non-zero exit + named failing check on FAIL (never a silent "deployed").

`package.json`: `"deploy": "powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1"`.

### 3.4 Reboot survival (`scripts/setup-autologon.ps1` + runbook)

- Enable auto-logon via Sysinternals **Autologon** (LSA-secret, not plaintext registry). If
  Autologon.exe is absent, print manual steps; never write `DefaultPassword`.
- `pm2 save` captures `acolad-bot` so `pm2 resurrect` (run by pm2-windows-startup on logon)
  restores it; deploy already asserts the dump (§3.3 step 4).
- **Auto-logon failure modes (new — these fail SILENTLY; Healthchecks is the detection net):**
  - Windows/domain password rotation invalidates the stored secret → next reboot stops at the
    login screen → bot down. Detected by Healthchecks (heartbeat stops, paged in ≤5 min).
  - Windows Update boots into "configuring updates"/recovery → auto-logon doesn't run. Residual
    risk; same detection.
  - Runbook: "if heartbeat doesn't return after a reboot → check auto-logon first
    (`AutoAdminLogon`, Autologon secret), then `pm2 resurrect`."

### 3.5 Quick wins

- **Healthchecks:** set period **60s**, grace **300s** in the Healthchecks.io UI (no code) so a
  stopped bot OR a failed lock-refusal ping pages within ~5 min. Verify grace covers the longest
  browser-recycle cycle.
- **CLAUDE.md:** correct the status block — accept is now **ON** (ACCEPT_ENABLED=1,
  MAX_PER_CYCLE=0, RECON=0); reboot survival is auto-logon-based; remove the stale "accept ปิด"
  language; reference this spec + `npm run deploy` (and "never `pm2 restart` by hand").
- **Secret hygiene note:** add a CLAUDE.md caution to keep the repo OUT of any Google Drive /
  OneDrive backup set (user verifies in the Google Drive app — out of band).

## 4. Startup / shutdown sequence (after change)

```
main() →
  loadConfig()                                  // Healthchecks URL available for refusal ping
  → acquireSingleInstanceLock({port, retryMs:45000, onRefused: pingHealthchecksFail})
        EADDRINUSE → retry ≤45s → still held → ping /fail + log + exit(1)
  → createXtmBot() → loop.runOnce() every ~20s
  on SIGTERM (pm2 stop/deploy):
    running=false + arm watchdog(25s); 2nd SIGTERM → force now
    forceShutdown(): disposeWithTimeout(8s) → db.close() → release() → exit(0)
        → OS releases port 47811           (always ≤ ~33s < kill_timeout 35s → no orphan)
```

## 5. Error handling

- Lock refused → ping Healthchecks /fail (dead-man switch) + loud log + exit(1). Distinguishes
  own-instance vs foreign-port-holder (logs holder PID).
- `browser.dispose()` hang → bounded by DISPOSE_TIMEOUT (never blocks exit) + loud `dispose_timeout`
  log; leftover Chromium reaped by next deploy sweep (in-process tree-kill deferred — see §3.2 note).
- Deploy verify FAIL → non-zero exit naming the failing check; never a silent "deployed".

## 6. Testing

- Unit (`tests/unit/singleInstance.test.ts`): acquire on an ephemeral port; a second acquire
  (short retry) rejects AND invokes `onRefused`; after `release()`, a third acquire succeeds.
- Unit: `disposeWithTimeout` returns within the timeout when the underlying close hangs.
- The watchdog/SIGTERM path, kill_timeout, and the PowerShell scripts are ops-verified on the box.
- Full suite stays green; lint + typecheck clean.

## 7. Out of scope

- Replacing PM2 with a Windows Service (NSSM) — rejected in favor of auto-logon.
- Full cooperative cancellation via AbortSignal (noted as a stretch in §3.2).
- The deferred type refactors from the code review (acceptability enum, eventType tagged union).
- Daily-summary report (already deferred in plan.md Complexity Tracking).
- Any change to the detect/accept business logic.
