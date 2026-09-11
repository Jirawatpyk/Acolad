/**
 * PM2 config for the Phase 0 Straker probe ONLY. The name must end in
 * `.config.cjs`: PM2 only treats a file as an app definition when the filename matches
 * that convention, and runs it as a plain script otherwise (which exits immediately).
 *
 * Deliberately a SEPARATE file from ecosystem.config.cjs: that one belongs to the live
 * XTM bot, and `npm run deploy` drives it. Keeping the probe out of it means a probe
 * restart can never disturb the running bot, and deleting this file is the whole
 * teardown once Phase 0 ends.
 *
 *   Start:  pm2 start recon.config.cjs
 *   Stop:   pm2 delete jobcatch-straker-recon
 */
module.exports = {
  apps: [
    {
      name: 'jobcatch-straker-recon',
      script: 'dist/straker/reconMain.js',
      cwd: __dirname,
      autorestart: true,
      windowsHide: true,
      max_memory_restart: '300M',
      restart_delay: 5000,
      out_file: 'logs/straker-recon-out.log',
      error_file: 'logs/straker-recon-err.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Bangkok',
      },
    },
  ],
};
