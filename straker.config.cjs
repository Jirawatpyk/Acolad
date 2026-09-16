/**
 * PM2 config for the JobCatch Straker bot (FR-024, FR-032). The name must end in
 * `.config.cjs`: PM2 only treats a file as an app definition when the filename matches
 * that convention, and runs it as a plain script otherwise (which exits immediately).
 *
 * Deliberately a SEPARATE file from ecosystem.config.cjs (the live XTM bot) and from
 * recon.config.cjs (the temporary capture probe). One file per bot is what lets
 * `npm run deploy -- -Target straker` release or restart this one without stopping,
 * starting or saving either of the others (FR-026, V12) - and it keeps the XTM bot's
 * definition a file this feature never has to edit.
 *
 *   Release: npm run deploy -- -Target straker   (build + stop-and-wait + verify)
 *   Stop:    pm2 stop jobcatch-straker
 */
module.exports = {
  apps: [
    {
      name: 'jobcatch-straker',
      script: 'dist/straker/main.js',
      // Run from the project root regardless of where pm2 is invoked, so the relative
      // script/log paths and .env resolve correctly.
      cwd: __dirname,
      autorestart: true,
      windowsHide: true,
      // No Chromium here - Straker is read over HTTP - so the XTM bot's 900M browser
      // allowance does not apply. 500M sits well clear of the expected steady state
      // (node + better-sqlite3 + googleapis) while still catching a real leak, and above
      // the read-only probe's 300M because the bot also carries a store and a Sheets
      // client. Set too low it would restart a healthy bot mid-race, which costs offers.
      max_memory_restart: '500M',
      restart_delay: 5000,
      // 10s, not the XTM bot's 35s: that allowance is entirely Chromium's dispose path,
      // and there is no browser here. What must finish on stop is an in-flight HTTP
      // request, the SQLite commit behind it and the log flush - 10s is generous for all
      // three and stays well inside deploy.ps1's 45s wait for the lock port to free.
      // (On this Windows host PM2 delivers no stop signal at all and kills after ~7s, so
      // read this as the ceiling rather than as the observed shutdown time.)
      kill_timeout: 10000,
      // Own log files. The two bots share the logs/ directory but never a file, so one
      // bot's output can never be mistaken for the other's while reading an incident.
      out_file: 'logs/straker-out.log',
      error_file: 'logs/straker-err.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        // Pin the process timezone so every Bangkok date the shared scheduling gate
        // computes is the same here as in tests, regardless of the host OS setting.
        TZ: 'Asia/Bangkok',
        // src/straker/main.ts starts a bot ONLY when this is '1' - the guard that lets a
        // test import the module without a live bot appearing. This is the one process
        // that is meant to be the entry, so it is the one place the flag is set. Without
        // it `node dist/straker/main.js` loads the module and exits, and PM2 reports a
        // clean start for a bot that never ran.
        STRAKER_BOT_ENTRY: '1',
      },
    },
  ],
};
