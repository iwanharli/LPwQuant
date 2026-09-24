// pm2 process definitions. Usage (from the repo root):
//   npm install                 # installs pm2 locally
//   npm run dashboard:build     # once, and after dashboard changes
//   npm run up                  # start everything
//   npm run status | logs | restart | down
const path = require("node:path");

const root = __dirname;
const common = {
  autorestart: true,
  restart_delay: 5000,
  max_restarts: 50,
  time: false,
  log_date_format: "YYYY-MM-DD HH:mm:ss Z",
  merge_logs: true,
  env: { TZ: "Asia/Jakarta" },
};

module.exports = {
  apps: [
    {
      ...common,
      name: "quant-ingestor",
      cwd: path.join(root, "ingestor"),
      script: "npm",
      args: "start",
      out_file: path.join(root, "logs/ingestor.log"),
      error_file: path.join(root, "logs/ingestor.log"),
    },
    {
      ...common,
      name: "quant-engine",
      cwd: path.join(root, "engine"),
      script: "uv",
      args: "run uvicorn app.main:app --host 127.0.0.1 --port 8000",
      interpreter: "none",
      out_file: path.join(root, "logs/engine.log"),
      error_file: path.join(root, "logs/engine.log"),
    },
    {
      ...common,
      name: "quant-dashboard",
      cwd: path.join(root, "dashboard"),
      script: "npm",
      // DASHBOARD_PORT lets a server that already uses 3000 put the dashboard elsewhere.
      args: `start -- --port ${process.env.DASHBOARD_PORT || 3000}`,
      out_file: path.join(root, "logs/dashboard.log"),
      error_file: path.join(root, "logs/dashboard.log"),
    },
    {
      // Nightly database backup at 03:00 WIB; runs once per cron tick, never restarted in between.
      ...common,
      name: "quant-backup",
      cwd: root,
      script: path.join(root, "scripts/backup-db.sh"),
      interpreter: "bash",
      autorestart: false,
      cron_restart: "0 3 * * *",
      out_file: path.join(root, "logs/backup.log"),
      error_file: path.join(root, "logs/backup.log"),
    },
    {
      // Keeps the Mac awake (display may sleep) while the stack runs. Stop it with: npx pm2 stop quant-awake
      ...common,
      name: "quant-awake",
      script: "caffeinate",
      args: "-ims",
      interpreter: "none",
      out_file: "/dev/null",
      error_file: "/dev/null",
    },
  ],
};
