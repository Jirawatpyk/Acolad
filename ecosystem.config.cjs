module.exports = {
  apps: [
    {
      name: 'acolad-bot',
      script: 'dist/runtime/main.js',
      // Run from the project root regardless of where pm2 is invoked, so the
      // relative script/log paths and .env resolve correctly.
      cwd: __dirname,
      autorestart: true,
      // Belt-and-suspenders: browser.ts already uses channel:'chromium' (full GUI binary)
      // to avoid chrome-headless-shell.exe's stray console window; windowsHide hides any
      // console PM2 itself spawns regardless — matching the other PM2 bots' config.
      windowsHide: true,
      max_memory_restart: '900M',
      restart_delay: 5000,
      // Give the bot's bounded graceful shutdown (force-dispose watchdog 25s + dispose
      // cap 8s = ~33s) time to close Chromium before SIGKILL, so no orphaned browser.
      kill_timeout: 35000,
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-err.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        // Pin the process timezone so normalizeXtmDue's Date.parse of an XTM Due cell
        // (which carries no explicit zone) is interpreted as Bangkok regardless of the
        // host OS setting — otherwise a non-Bangkok host shifts every due_date (review #7/#13).
        TZ: 'Asia/Bangkok',
      },
    },
  ],
};
