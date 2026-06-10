module.exports = {
  apps: [
    {
      name: 'acolad-bot',
      script: 'dist/runtime/main.js',
      autorestart: true,
      max_memory_restart: '900M',
      restart_delay: 5000,
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-err.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
