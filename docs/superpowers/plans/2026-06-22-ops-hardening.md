# Ops Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee at most one `acolad-bot` poller ever runs, make shutdown bounded (no orphaned Chromium), give a single-instance-safe deploy, and survive reboots.

**Architecture:** A port-bind single-instance lock (`net` sentinel on 127.0.0.1) refuses a second poller and doubles as the deploy's orphan detector. SIGTERM triggers a *bounded* shutdown (force-dispose watchdog + a `withTimeout` cap on `browser.close()`) so the process always exits before PM2's `kill_timeout` SIGKILL — fixing the orphan root cause. A PowerShell deploy script and an auto-logon helper close the ops gaps.

**Tech Stack:** Node 22, TypeScript (NodeNext ESM, strict), Vitest, PM2 (fork) on Windows 11, PowerShell 5.1, Playwright.

## Global Constraints

- TypeScript strict, NodeNext ESM — **relative imports MUST end in `.js`** (e.g. `./singleInstance.js`).
- `npm run lint` (eslint + prettier) and `npm run typecheck` MUST stay clean; `npm test` MUST stay green (currently 248 tests).
- Secrets only in `.env` (gitignored) — never log credentials/URLs (pino redaction).
- The shared XTM account makes "≤1 poller ever" a hard safety invariant.
- Tunables (reconciled in the spec): `SINGLE_INSTANCE_PORT=47811`, bind-retry `45_000`ms, `SHUTDOWN_BUDGET_MS=25_000`, `DISPOSE_TIMEOUT_MS=8_000`, PM2 `kill_timeout=35_000`, deploy verify `90_000`ms.
- Spec: `docs/superpowers/specs/2026-06-22-ops-hardening-design.md` (authoritative).

---

## File Structure

- `src/withTimeout.ts` (new) — generic `withTimeout(promise, ms)` helper. One responsibility: bound a promise.
- `src/runtime/singleInstance.ts` (new) — port-bind lock. One responsibility: acquire/refuse/release the single-instance lock.
- `src/config/index.ts` (modify) — add `SINGLE_INSTANCE_PORT`.
- `src/portal/browser.ts` (modify) — bound `dispose()`/`recycle()` closes with `withTimeout`.
- `src/runtime/main.ts` (modify) — acquire lock first; bounded SIGTERM shutdown.
- `src/runtime/once.ts` (modify) — acquire lock; release in `finally`.
- `ecosystem.config.cjs` (modify) — `kill_timeout: 35000`.
- `scripts/deploy.ps1` (new) + `package.json` (modify) — safe deploy.
- `scripts/setup-autologon.ps1` (new) — reboot survival helper.
- `CLAUDE.md` (modify) — status + runbook + secret note.
- Tests: `tests/unit/withTimeout.test.ts`, `tests/unit/singleInstance.test.ts` (new).

---

### Task 1: `withTimeout` helper + bound browser dispose

**Files:**
- Create: `src/withTimeout.ts`
- Create: `tests/unit/withTimeout.test.ts`
- Modify: `src/portal/browser.ts:86-98` (recycle + dispose)

**Interfaces:**
- Produces: `withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined>` — resolves with the value if `p` settles first, or `undefined` on timeout; NEVER rejects (safe in shutdown paths).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/withTimeout.test.ts
import { describe, it, expect } from 'vitest';
import { withTimeout } from '../../src/withTimeout.js';

describe('withTimeout', () => {
  it('returns the value when the promise settles in time', async () => {
    expect(await withTimeout(Promise.resolve(42), 1000)).toBe(42);
  });

  it('returns undefined when the promise hangs past the timeout (never rejects)', async () => {
    const hang = new Promise<number>(() => {}); // never resolves
    const start = Date.now();
    const r = await withTimeout(hang, 30);
    expect(r).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('swallows a rejection and resolves undefined', async () => {
    expect(await withTimeout(Promise.reject(new Error('x')), 1000)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/withTimeout.test.ts`
Expected: FAIL — cannot resolve `../../src/withTimeout.js`.

- [ ] **Step 3: Write the helper**

```typescript
// src/withTimeout.ts
/**
 * Resolve when `p` settles or `ms` elapses, whichever is first. On timeout (or if
 * `p` rejects) it resolves `undefined` — it NEVER rejects, so it is safe to use on
 * shutdown/cleanup paths where a hung close must not block process exit.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([p.catch(() => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/withTimeout.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Apply `withTimeout` in browser.ts (bound the closes)**

Modify `src/portal/browser.ts`. Add the import at the top (after the existing imports):

```typescript
import { withTimeout } from '../withTimeout.js';

const CLOSE_TIMEOUT_MS = 8_000;
```

Replace `recycle()` (lines 86-91) and `dispose()` (lines 93-98) with:

```typescript
  /** Recycle: open a fresh context before disposing the old one (no heartbeat gap). */
  async recycle(): Promise<void> {
    const old = { browser: this.browser, context: this.context };
    await this.open();
    if (old.context) await withTimeout(old.context.close(), CLOSE_TIMEOUT_MS);
    if (old.browser) await withTimeout(old.browser.close(), CLOSE_TIMEOUT_MS);
  }

  async dispose(): Promise<void> {
    if (this.context) await withTimeout(this.context.close(), CLOSE_TIMEOUT_MS);
    if (this.browser) await withTimeout(this.browser.close(), CLOSE_TIMEOUT_MS);
    this.context = undefined;
    this.browser = undefined;
  }
```

- [ ] **Step 6: Verify typecheck/lint/tests**

Run: `npm run typecheck; npm run lint; npm test`
Expected: typecheck + lint clean; all tests pass (251 = 248 + 3).

- [ ] **Step 7: Commit**

```bash
git add src/withTimeout.ts tests/unit/withTimeout.test.ts src/portal/browser.ts
git commit -m "feat(ops): add withTimeout + bound browser close so a hung Chromium never blocks shutdown"
```

---

### Task 2: Single-instance lock + config

**Files:**
- Create: `src/runtime/singleInstance.ts`
- Create: `tests/unit/singleInstance.test.ts`
- Modify: `src/config/index.ts` (add `SINGLE_INSTANCE_PORT`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `acquireSingleInstanceLock(opts: { port: number; retryMs: number; onRefused?: () => Promise<void>; sleep?: (ms: number) => Promise<void> }): Promise<() => Promise<void>>` — resolves with an async `release()` when this process owns the lock; on failure awaits `onRefused()` then rejects.
  - config gains `SINGLE_INSTANCE_PORT: number` (default 47811).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/singleInstance.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:net';
import { acquireSingleInstanceLock } from '../../src/runtime/singleInstance.js';

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

describe('acquireSingleInstanceLock', () => {
  it('acquires a free port; a second acquire is refused and calls onRefused', async () => {
    const port = await freePort();
    const release = await acquireSingleInstanceLock({ port, retryMs: 0 });
    const onRefused = vi.fn(async () => {});
    await expect(acquireSingleInstanceLock({ port, retryMs: 0, onRefused })).rejects.toThrow();
    expect(onRefused).toHaveBeenCalledTimes(1);
    await release();
  });

  it('re-acquires after release', async () => {
    const port = await freePort();
    await (await acquireSingleInstanceLock({ port, retryMs: 0 }))();
    const release2 = await acquireSingleInstanceLock({ port, retryMs: 0 });
    await release2(); // succeeded → no throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/singleInstance.test.ts`
Expected: FAIL — cannot resolve `singleInstance.js`.

- [ ] **Step 3: Write the lock module**

```typescript
// src/runtime/singleInstance.ts
import { createServer, type Server } from 'node:net';

export interface SingleInstanceOpts {
  /** localhost TCP port used as the lock token. */
  port: number;
  /** how long to retry on EADDRINUSE before giving up (rides out an old instance's shutdown). */
  retryMs: number;
  /** called once, right before rejecting, so a refusal can page the dead-man switch. */
  onRefused?: () => Promise<void>;
  /** injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Acquire a single-instance lock by binding 127.0.0.1:<port>. The OS frees the port
 * when this process dies (no stale-lock handling). On EADDRINUSE it retries for
 * `retryMs` to ride out an old instance's shutdown; still held → awaits onRefused()
 * then rejects. Returns an async release().
 */
export async function acquireSingleInstanceLock(
  opts: SingleInstanceOpts,
): Promise<() => Promise<void>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + opts.retryMs;
  for (;;) {
    try {
      const server = await listen(opts.port);
      return () => close(server);
    } catch (err) {
      const inUse = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (inUse && Date.now() < deadline) {
        await sleep(500);
        continue;
      }
      await opts.onRefused?.();
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    // Sentinel server: destroy any real connection — it exists only to hold the port.
    const server = createServer((sock) => sock.destroy());
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/singleInstance.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the config key**

In `src/config/index.ts`, inside the `z.object({ ... })` schema (next to the other tuning vars like `POLL_INTERVAL_MS`), add:

```typescript
  SINGLE_INSTANCE_PORT: z.coerce.number().int().min(1).max(65_535).default(47811),
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck; npm run lint; npm test`
Expected: clean + green (253 = 251 + 2).

- [ ] **Step 7: Commit**

```bash
git add src/runtime/singleInstance.ts tests/unit/singleInstance.test.ts src/config/index.ts
git commit -m "feat(ops): port-bind single-instance lock + SINGLE_INSTANCE_PORT config"
```

---

### Task 3: Wire lock + bounded shutdown into entrypoints + PM2

**Files:**
- Modify: `src/runtime/main.ts`
- Modify: `src/runtime/once.ts`
- Modify: `ecosystem.config.cjs`

**Interfaces:**
- Consumes: `acquireSingleInstanceLock` (Task 2), `withTimeout` (Task 1), `loadConfig` (existing).

- [ ] **Step 1: Rewrite `src/runtime/main.ts`**

Replace the whole file with:

```typescript
import { MetaStore } from '../state/meta.js';
import { raiseAlert } from '../reporting/systemAlerts.js';
import { ColdStartHistory } from './coldStartHistory.js';
import { createXtmBot } from './bootstrap.js';
import { computeNextDelay, jitter } from './scheduler.js';
import { systemClock } from '../clock.js';
import { loadConfig } from '../config/index.js';
import { acquireSingleInstanceLock } from './singleInstance.js';
import { withTimeout } from '../withTimeout.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const stamp = (): string => new Date().toLocaleTimeString('en-GB');

const LOCK_RETRY_MS = 45_000; // >= PM2 kill_timeout (35s) so a new instance waits out the old's shutdown
const SHUTDOWN_BUDGET_MS = 25_000; // force shutdown if the loop hasn't exited by now
const DISPOSE_TIMEOUT_MS = 8_000; // cap on the final browser dispose

/** Long-running 24/7 entrypoint under PM2 (npm start). */
async function main(): Promise<void> {
  const cfg0 = loadConfig();

  // Single-instance guard (port-bind). A refusal pings the Healthchecks dead-man switch
  // BEFORE exit — nobody watches `pm2 status`, and this runs before the bot's heartbeat exists.
  let release: () => Promise<void>;
  try {
    release = await acquireSingleInstanceLock({
      port: cfg0.SINGLE_INSTANCE_PORT,
      retryMs: LOCK_RETRY_MS,
      onRefused: () =>
        fetch(`${cfg0.HEALTHCHECKS_PING_URL}/fail`)
          .then(() => undefined)
          .catch(() => undefined),
    });
  } catch {
    console.error(
      `[${stamp()}] acolad-bot: another instance owns port ${cfg0.SINGLE_INSTANCE_PORT} — refusing to start (single-instance).`,
    );
    process.exit(1);
    return; // unreachable; satisfies the type checker
  }

  const { cfg, logger, db, outbox, rate, client, loop } = createXtmBot();

  // Cold-start-repeat detection (FR-015): only counts when there is no baseline yet.
  if (!new MetaStore(db).baselineDone) {
    if (new ColdStartHistory(cfg.LOG_DIR).record(systemClock.nowIso())) {
      raiseAlert(db, outbox, 'cold_start_repeat', systemClock.nowIso(), 'เริ่มแบบไม่มีฐานสถานะซ้ำใน 7 วัน');
    }
  }

  let running = true;
  let forcing = false;
  // Bounded shutdown: dispose the browser (capped) + release the lock + exit — never wait
  // for an in-flight cycle (disposing mid-cycle just errors the caught Playwright calls).
  const forceShutdown = async (): Promise<void> => {
    if (forcing) return;
    forcing = true;
    await withTimeout(client.dispose(), DISPOSE_TIMEOUT_MS);
    db.close();
    await release().catch(() => undefined);
    logger.info({ module: 'main', action: 'shutdown', outcome: 'forced' }, 'acolad-bot stopped (bounded)');
    process.exit(0);
  };
  const shutdown = (signal: string): void => {
    logger.info({ module: 'main', action: 'shutdown', signal }, 'graceful shutdown requested');
    console.log(`[${stamp()}] ได้รับสัญญาณ ${signal} — กำลังปิดอย่างนุ่มนวล...`);
    if (!running) {
      void forceShutdown(); // second signal → force now
      return;
    }
    running = false;
    setTimeout(() => void forceShutdown(), SHUTDOWN_BUDGET_MS).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info({ module: 'main', action: 'startup', outcome: 'ok' }, 'acolad-xtm-bot started');
  console.log(
    `[${stamp()}] acolad-bot (XTM) เริ่มทำงาน — เฝ้า ${cfg.XTM_ACOLAD_OFFERS_URL} | accept=${cfg.ACCEPT_ENABLED ? 'ON' : 'OFF'}`,
  );
  console.log(`[${stamp()}] log ละเอียดอยู่ที่ ${cfg.LOG_DIR}/  (Ctrl+C เพื่อหยุด)`);

  while (running) {
    const cycleStart = systemClock.nowMs();
    const ok = await loop.runOnce();
    console.log(`[${stamp()}] รอบตรวจ: ${ok ? 'OK' : 'มีปัญหา (ดู log/Google Chat)'}`);

    const cycleDurationMs = systemClock.nowMs() - cycleStart;
    const j = jitter(5_000, Math.random());
    let delay = computeNextDelay({ intervalMs: cfg.POLL_INTERVAL_MS, cycleDurationMs, jitterMs: j });
    const waitForSlot = rate.msUntilSlot(systemClock.nowMs());
    if (waitForSlot > delay) {
      logger.warn(
        { module: 'main', action: 'rate_limit', outcome: 'deferred', waitMs: waitForSlot },
        'request cap reached — extending interval',
      );
      delay = waitForSlot;
    }
    await sleep(delay);
  }

  // Normal exit (loop ended cooperatively before the watchdog fired).
  await withTimeout(client.dispose(), DISPOSE_TIMEOUT_MS);
  db.close();
  await release().catch(() => undefined);
  logger.info({ module: 'main', action: 'shutdown', outcome: 'ok' }, 'acolad-bot stopped');
  console.log(`[${stamp()}] acolad-bot หยุดแล้ว`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Wire the lock into `src/runtime/once.ts`**

Replace the whole file with:

```typescript
import { ColdStartHistory } from './coldStartHistory.js';
import { createXtmBot } from './bootstrap.js';
import { systemClock } from '../clock.js';
import { loadConfig } from '../config/index.js';
import { acquireSingleInstanceLock } from './singleInstance.js';

/** Run a single poll cycle then exit (smoke test — npm run poll:once). */
async function main(): Promise<void> {
  const cfg0 = loadConfig();
  // Single-instance: refuse if the 24/7 bot (or another poll:once) is running — a concurrent
  // poll on the shared account could double-accept. Stop the bot before poll:once.
  let release: () => Promise<void>;
  try {
    release = await acquireSingleInstanceLock({ port: cfg0.SINGLE_INSTANCE_PORT, retryMs: 0 });
  } catch {
    console.error(
      `acolad-bot: another instance owns port ${cfg0.SINGLE_INSTANCE_PORT} — stop the bot before poll:once.`,
    );
    process.exit(1);
    return;
  }

  const { cfg, db, client, loop } = createXtmBot();
  try {
    const ok = await loop.runOnce();
    console.log(ok ? 'poll:once OK' : 'poll:once completed with errors (see logs/alerts)');
    if (ok) new ColdStartHistory(cfg.LOG_DIR).record(systemClock.nowIso());
  } finally {
    await client.dispose();
    db.close();
    await release().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
```

- [ ] **Step 3: Add `kill_timeout` to `ecosystem.config.cjs`**

In the app object (after `restart_delay: 5000,`), add:

```javascript
      // Give the bot's bounded graceful shutdown (force-dispose watchdog 25s + dispose
      // cap 8s = ~33s) time to close Chromium before SIGKILL, so no orphaned browser.
      kill_timeout: 35000,
```

- [ ] **Step 4: Verify build + suite (integration is ops-verified on the box)**

Run: `npm run typecheck; npm run lint; npm test; npm run build`
Expected: clean + green (253) + build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/main.ts src/runtime/once.ts ecosystem.config.cjs
git commit -m "feat(ops): acquire single-instance lock first + bounded SIGTERM shutdown + kill_timeout"
```

---

### Task 4: Safe deploy script

**Files:**
- Create: `scripts/deploy.ps1`
- Modify: `package.json` (add the `deploy` script)

**Interfaces:**
- Consumes: the single-instance lock port (47811) as the orphan signature.

- [ ] **Step 1: Write `scripts/deploy.ps1`**

```powershell
# One-command, single-instance-safe deploy. NEVER `pm2 restart` by hand — always this.
$ErrorActionPreference = 'Stop'
$App  = 'acolad-bot'
$Port = 47811
$root = Split-Path -Parent $PSScriptRoot

function Port-Holder($p) {
  (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty OwningProcess)
}
function Wait-PortFree($p, $timeoutSec) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (-not (Port-Holder $p)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

Write-Host '== 1/5 build =='
Push-Location $root
npm run build
if (-not $?) { Pop-Location; throw 'build failed' }

Write-Host '== 2/5 stop + wait for port free =='
pm2 stop $App | Out-Null
if (-not (Wait-PortFree $Port 45)) {
  # 3/5 orphan sweep — the lock port is acolad's signature, so the holder IS an orphan.
  Write-Host '== 3/5 orphan still holds the lock port — sweeping =='
  $orphan = Port-Holder $Port
  if ($orphan) {
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
      Where-Object { $_.ParentProcessId -eq $orphan } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $orphan -Force -ErrorAction SilentlyContinue
    if (-not (Wait-PortFree $Port 10)) { Pop-Location; throw "port $Port still held by PID $orphan after sweep" }
    Write-Host "  killed orphan PID $orphan + its Chromium children"
  }
}

Write-Host '== 4/5 start + save =='
pm2 start ecosystem.config.cjs | Out-Null
pm2 save | Out-Null
if (-not (pm2 prettylist 2>$null | Select-String "name: '$App'")) { Pop-Location; throw 'pm2 dump missing acolad-bot' }

Write-Host '== 5/5 verify (<=90s) =='
$log = Get-ChildItem "$root/logs/acolad.*.log" | Sort-Object LastWriteTime | Select-Object -Last 1
$mark = (Get-Date)
$ok = $false
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  $fresh = Get-Content $log.FullName -Tail 40 |
    Select-String '"action":"cycle","outcome":"ok"'
  if ($fresh -and ((Get-Item $log.FullName).LastWriteTime -gt $mark)) { $ok = $true; break }
  Start-Sleep -Seconds 3
}
$holder = Port-Holder $Port
Pop-Location
if (-not $ok)     { throw 'FAIL: no fresh "poll cycle ok" within 90s' }
if (-not $holder) { throw 'FAIL: lock port not held after start' }
Write-Host "PASS: deployed, single instance (PID $holder holds port $Port), cycle ok" -ForegroundColor Green
```

- [ ] **Step 2: Add the npm script**

In `package.json` `"scripts"`, add:

```json
    "deploy": "powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1",
```

- [ ] **Step 3: Ops-verify the deploy**

Run: `npm run deploy`
Expected: prints `== 1/5 ..` through `PASS: deployed, single instance ...`. Then confirm: `pm2 status acolad-bot` online, and exactly one acolad ProcessContainerFork.

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy.ps1 package.json
git commit -m "feat(ops): single-instance-safe deploy script (npm run deploy)"
```

---

### Task 5: Reboot-survival helper + runbook

**Files:**
- Create: `scripts/setup-autologon.ps1`

**Interfaces:** none (standalone ops helper).

- [ ] **Step 1: Write `scripts/setup-autologon.ps1`**

```powershell
# One-time: enable Windows auto-logon so the dedicated bot box resurrects PM2 after a reboot
# WITHOUT a human logging in. Uses Sysinternals Autologon (stores the secret in the LSA, NOT
# plaintext registry). If Autologon.exe is absent, prints the manual steps and does nothing.
$ErrorActionPreference = 'Stop'
$autologon = (Get-Command Autologon.exe -ErrorAction SilentlyContinue)?.Source
if (-not $autologon) { $autologon = (Get-Command Autologon64.exe -ErrorAction SilentlyContinue)?.Source }

if (-not $autologon) {
  Write-Host 'Sysinternals Autologon not found.' -ForegroundColor Yellow
  Write-Host 'Download: https://learn.microsoft.com/sysinternals/downloads/autologon'
  Write-Host 'Then run: Autologon.exe <username> <domain-or-.> <password>   (stores secret in LSA, not plaintext)'
  Write-Host 'Do NOT set HKLM\...\Winlogon\DefaultPassword by hand (plaintext).'
  exit 1
}

Write-Host "Found Autologon at $autologon"
Write-Host 'Run it interactively to enter the credential (it stores the secret in the LSA):'
Write-Host "  & `"$autologon`""
Write-Host ''
Write-Host 'After enabling auto-logon, confirm PM2 resurrect is wired:'
Write-Host '  pm2 save                 # capture the current process list (incl. acolad-bot)'
Write-Host '  pm2 status               # acolad-bot should be online'
Write-Host ''
Write-Host 'Reboot survival test: reboot the machine; the bot must come back WITHOUT logging in,'
Write-Host 'and the Healthchecks heartbeat must turn green within the 300s grace.'
```

- [ ] **Step 2: Ops-verify (manual, on the box)**

Run (interactive): `powershell -ExecutionPolicy Bypass -File scripts/setup-autologon.ps1`, follow its instructions, then reboot once and confirm the bot returns + heartbeat green without logging in.

- [ ] **Step 3: Commit**

```bash
git add scripts/setup-autologon.ps1
git commit -m "feat(ops): reboot-survival auto-logon setup helper (LSA-secret via Sysinternals)"
```

---

### Task 6: CLAUDE.md status + runbook + secret note

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Update the status + accept block**

In `CLAUDE.md`, in the "## Project Overview" / "สถานะปัจจุบัน" area and the "กดรับงานยังปิดอยู่โดยตั้งใจ" blockquote, replace the "accept ปิด (ACCEPT_ENABLED=0)" language with the current reality:

> **สถานะ accept**: เปิดแล้ว (ACCEPT_ENABLED=1, ACCEPT_MAX_PER_CYCLE=0, ACCEPT_RECON=0) ตั้งแต่ 2026-06-22 — detect+log+notify+auto-accept ครบ. D4/D6 ยืนยันแล้ว (เมนู accept inline, "Accept task"→"Finish task" หลังรับ). **ACCEPT_MAX_PER_CYCLE ต้องเป็น 0** (cap>0 อันตราย — bulk กดทั้งกลุ่ม ดู acceptDecision.ts).

- [ ] **Step 2: Replace the deploy/restart guidance + add the reboot runbook**

In the "Commands" / "รัน 24/7" section, replace the `pm2 start ecosystem.config.cjs` line with:

```powershell
npm run deploy          # build + single-instance-safe restart + verify (ALWAYS use this)
# ห้าม `pm2 restart acolad-bot` ด้วยมือ — มัน skip stop-and-wait แล้วทิ้ง orphan/ชน lock
```

Add a "## รัน 24/7 + reboot survival" note:

```markdown
- single-instance: บอท bind 127.0.0.1:47811 ตอน start — ตัวที่ 2 จะ refuse + ping Healthchecks /fail
- reboot: เปิด auto-logon (scripts/setup-autologon.ps1) + `pm2 save` → pm2-windows-startup ปลุกหลัง logon
- ถ้า reboot แล้ว heartbeat ไม่กลับ ใน 5 นาที → เช็ค auto-logon (AutoAdminLogon, Autologon LSA secret) ก่อน แล้ว `pm2 resurrect`
```

- [ ] **Step 3: Add the secret-hygiene + Healthchecks note**

In "## ข้อควรระวังเฉพาะโปรเจกต์", add:

```markdown
- **ห้ามให้ repo อยู่ใต้ Google Drive / OneDrive backup** — .gitignore ไม่กัน cloud sync; .env + google-credentials.json + state/storageState.json จะรั่ว (ตรวจในแอป Google Drive → Settings → Folders)
- **Healthchecks**: ตั้ง period 60s / grace 300s — ถ้าบอทหยุดหรือ lock refuse จะ page ทีมใน ~5 นาที
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(ops): CLAUDE.md — accept=ON status, npm run deploy, reboot + secret runbook"
```

---

## Self-Review

**Spec coverage:**
- §3.1 lock + config + onRefused/Healthchecks + once.ts → Tasks 2, 3 ✅
- §3.2 bounded shutdown (main watchdog + browser dispose timeout + kill_timeout) → Tasks 1, 3 ✅
- §3.3 deploy script (build→stop→wait→orphan sweep→start→save→verify) → Task 4 ✅ (orphan sweep refined to use the lock port as the acolad signature — strictly safer than the spec's command-line match, never touches AutoRWS)
- §3.4 auto-logon helper + runbook → Tasks 5, 6 ✅
- §3.5 quick wins (CLAUDE.md status/secret + Healthchecks doc) → Task 6 ✅
- §6 testing (withTimeout, singleInstance unit tests; ops-verify the rest) → Tasks 1, 2 + ops steps ✅

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `acquireSingleInstanceLock(opts)` signature + the `release: () => Promise<void>` return are used identically in Tasks 2/3; `withTimeout(p, ms)` identical in Tasks 1/3; `SINGLE_INSTANCE_PORT` / port 47811 consistent across config, main, once, deploy.

**Note (resolved during planning):** deploy orphan-sweep uses the lock port holder (`Get-NetTCPConnection -LocalPort 47811`) as the precise acolad signature instead of fuzzy command-line matching — safer, and impossible to hit AutoRWS's Playwright Chromium.
