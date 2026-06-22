# Ops Hardening — single-instance safety, safe deploy, reboot survival

**Date:** 2026-06-22
**Feature branch:** 002-xtm-detect-accept
**Status:** Approved (brainstorming) — pending implementation plan

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
2. **Orphan root cause.** PM2's default `kill_timeout` (1.6s) sends SIGKILL before
   `main.ts`'s graceful shutdown (`running=false` → finish cycle → `client.dispose()` closes
   the browser) completes → the Chromium child is orphaned.
3. **No reboot survival without a logged-on session.** `pm2-windows-startup` is configured,
   but `AutoAdminLogon=0`, so an overnight Windows-Update reboot stops the bot until a human
   logs in. Jobs arrive ~4-5/day with a <1-min snatch window → silent downtime = missed jobs.
4. **Manual, footgun-prone deploy.** `build` → `pm2 restart` is exactly the step that orphans.
5. **Downtime not promptly detected.** Healthchecks period/grace not tuned to the 20s poll.

**Goal:** guarantee at most one poller ever runs, make deploys clean, survive reboots, and
detect downtime within minutes — without rewriting the runtime or dropping PM2.

## 2. Decisions (made during brainstorming)

- **Single-instance mechanism: port-bind.** OS-managed (port frees on process death → no
  stale-lock handling), cross-platform, zero new deps (`node:net`).
- **Reboot survival: auto-logon + existing PM2 startup.** Minimal change; uses what's already
  configured. Accepted trade-off (boots to a logged-in desktop; credential stored — mitigated
  via Sysinternals Autologon's LSA-secret storage rather than plaintext registry). The machine
  is a dedicated, physically-secured bot box.
- **Deploy as PowerShell** (`scripts/deploy.ps1`) — PowerShell is this machine's primary shell.
- **Tunables:** lock port `47811` (configurable), bind-retry window `15s`, PM2
  `kill_timeout 35000`, Healthchecks period `60s` / grace `300s`.

## 3. Components

### 3.1 F1 — Single-instance lock (`src/runtime/singleInstance.ts`)

New, single-purpose module.

- **Interface:** `acquireSingleInstanceLock(port: number, opts?: { retryMs?: number; logger?: Logger }): Promise<() => void>`
  - Resolves with a `release()` function when this process owns the lock.
  - Rejects (after the retry window) when another instance holds it.
- **Behavior:** `net.createServer()` that immediately destroys any incoming socket (it is a
  sentinel, not a real server) → `.listen(port, '127.0.0.1')`.
  - `listen` success → we are the sole instance; keep the server ref alive for the process
    lifetime; return `release = () => server.close()`.
  - `EADDRINUSE` → another instance is up (or an old one is still releasing during a restart).
    Retry every 500ms for `retryMs` (default 15_000). Still in use → reject.
  - Any other listen error → reject (fail loud).
- **Wiring:** called at the TOP of `main()` (and `once.ts`) BEFORE `createXtmBot()`. On
  rejection: log loud (`module: 'singleInstance', outcome: 'refused'`) + `console.error` a
  human line + `process.exit(1)`. PM2 will mark it errored (visible in `pm2 status`).
- **Config:** add `SINGLE_INSTANCE_PORT` (zod, default 47811) to `src/config/index.ts`.
- **Why retry:** on a clean `pm2 restart` the old process releases the port as it shuts down
  (graceful, within `kill_timeout`); the new process retries during that window and binds. A
  true zombie that never dies → new exits after 15s (loud), and the deploy script's stop-and-wait
  prevents that case.
- **Scope:** the 24/7 poller (`main.ts`) and the single-cycle poller (`once.ts`). Standalone
  diag scripts (`scripts/diag-*.ts`, `verify-*.mjs`) remain "stop the bot first" (documented) —
  they don't go through these entrypoints.

### 3.2 PM2 hardening (`ecosystem.config.cjs`)

- Add `kill_timeout: 35000` so a SIGTERM lets the current cycle finish + `client.dispose()`
  close the browser before SIGKILL → no orphaned Chromium.
- Confirm `main.ts`'s SIGTERM path disposes the browser (it does: `await client.dispose()`).
  No code change expected; verify only.

### 3.3 F2 — Deploy script (`scripts/deploy.ps1`, `npm run deploy`)

One command, single-instance-safe, idempotent:

1. `npm run build`
2. `pm2 stop acolad-bot` → wait until the process is gone AND port 47811 is free (poll, ≤40s).
3. Targeted orphan sweep: kill any leftover node ProcessContainerFork whose command line /
   `pm_exec_path` is acolad's `dist/runtime/main.js` and is NOT the pm2-tracked pid; kill its
   Chromium children by parent PID only (NEVER a broad `ms-playwright` sweep — that hit AutoRWS).
4. `pm2 start ecosystem.config.cjs` (or `pm2 restart`) + `pm2 save`.
5. Verify: exactly one acolad ProcessContainerFork, a `poll cycle ok` log line appears within
   ~30s, and the heartbeat is green. Print PASS/FAIL.

`package.json`: `"deploy": "powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1"`.

### 3.4 Reboot survival (`scripts/setup-autologon.ps1` + runbook)

- A helper that enables auto-logon via Sysinternals **Autologon** (LSA-secret storage, not
  plaintext registry). If Autologon.exe is absent, print the manual steps; do not write the
  plaintext `DefaultPassword` registry value.
- Ensure `pm2 save` has captured `acolad-bot` so `pm2 resurrect` (run by pm2-windows-startup
  on logon) restores it.
- Documented as a one-time runbook step in CLAUDE.md (security note included).

### 3.5 Quick wins

- **Healthchecks:** set the check's **period 60s, grace 300s** in the Healthchecks.io UI
  (no code) so a stopped bot pages the team within ~5 min. Document the values.
- **CLAUDE.md:** correct the status block — accept is now **ON** (ACCEPT_ENABLED=1,
  MAX_PER_CYCLE=0, RECON=0); reboot survival is auto-logon-based; remove the stale "ยังปิดอยู่"
  accept language; reference this spec + the deploy script.
- **Secret hygiene note:** add a one-line CLAUDE.md caution to keep the repo OUT of any
  Google Drive / OneDrive backup set (the user verifies in the Google Drive app — out of band).

## 4. Startup sequence (after change)

```
main() →
  acquireSingleInstanceLock(47811)   // refuse + exit(1) if another instance holds it
  → createXtmBot()
  → loop.runOnce() every ~20s
  on SIGTERM (pm2 stop/restart, within 35s kill_timeout):
    running=false → finish cycle → client.dispose() (close browser) → db.close() → exit
    → OS releases port 47811
```

## 5. Error handling

- Lock refused → exit(1) + loud log (operator sees errored process in `pm2 status`; no silent
  second poller).
- Lock acquired but a later listen error → reject → exit(1) (fail loud).
- Deploy verify FAIL → script exits non-zero with the failing check named; bot left in whatever
  state pm2 reports (operator investigates) — never a silent "deployed".

## 6. Testing

- Unit (`tests/unit/singleInstance.test.ts`): acquire the lock on an ephemeral port; a second
  acquire with a short retry window rejects; after `release()`, a third acquire succeeds.
- `kill_timeout` / graceful-shutdown + the PowerShell scripts are ops-verified (run on the box),
  not unit-tested.
- Full suite stays green; lint + typecheck clean.

## 7. Out of scope

- Replacing PM2 with a Windows Service (NSSM) — rejected in favor of auto-logon.
- The deferred type refactors from the code review (acceptability enum, eventType tagged union).
- Daily-summary report (already deferred in plan.md Complexity Tracking).
- Any change to the detect/accept business logic.
