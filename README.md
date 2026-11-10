# Viman Mobile — Shop Management System

## What it is

A shop management program that runs on one PC in the shop. It works fully offline: nothing is sent to the internet and no account is needed. It keeps three cash books: **Shop**, **Telecom** and **Ice Cream**. It is a fresh start; no old records are imported.

## First-time setup

1. Install **Node.js 24 LTS** from https://nodejs.org (accept the default options).
2. Double-click `Start-Viman-Shop.bat`.
3. The first run needs the internet once to download the required files, then it builds the screens automatically. This can take a few minutes. Later runs are fast and need no internet.

## Daily use

1. Double-click `Start-Viman-Shop.bat`.
2. The browser opens at http://localhost:4300.
3. Keep the black window open while you work.
4. To stop, press Ctrl+C in the black window, or just close it.

## Where your data lives

- Database: `data\viman.db`
- Backups: `data\backups\`
- A backup is made automatically every time the program starts. The newest 30 are kept.
- Before any restore, a safety copy is made. The newest 10 safety copies are kept.

## Backups and restore

- Go to **Settings → Backups** and press **Backup now** to make a backup at any time.
- To restore, choose a backup and type `RESTORE` to confirm. A safety backup of the current data is taken first. You can also restore from a `.db` file.
- Tip: copy the `data\backups` folder to a USB drive every week.

## Troubleshooting

- **Port 4300 is in use:** the program is probably already running. Look for another black window and use it, or close it and start again.
- **"Node.js 24 or newer is required":** install Node.js 24 LTS from https://nodejs.org, then start again.
- **The build failed:** open a terminal in this folder, run `npm run build`, and read the error. Check the internet connection if the first-time install failed.
- **"The shop database is damaged":** this can happen after a power cut or disk fault. The system refuses to start so nothing is written on top of the damaged file. Follow the steps printed in the black window: rename `data\viman.db` to `viman-damaged.db` (and delete `viman.db-wal` / `viman.db-shm` if present), copy the newest file from `data\backups` into `data`, rename the copy to `viman.db`, and start again. Anything entered after that backup was made must be re-entered.
- **Restore rejected:** the chosen file is not a valid Viman database, or it is from a newer version of the program. Your current data is not changed. Pick a different backup.

## For developers

Scripts (run from the project root):

| Command | Purpose |
|---|---|
| `npm run dev:server` | Start the server with auto-restart |
| `npm run dev:web` | Start Vite on port 5173 (proxies `/api` to the server) |
| `npm test` | Run server tests |
| `npm run typecheck` | Type-check server and web |
| `npm run build` | Build the web app into `web/dist` |
| `npm start` | Run the server (serves the built web app) |

Environment variables: `VIMAN_DATA_DIR` (data folder), `VIMAN_PORT` (default 4300), `VIMAN_HOST`.

Documents: `ARCHITECTURE.md`, `BUSINESS_RULES.md`, `API_CONTRACTS.md`, `DATABASE_SCHEMA.md`, `TASKS.md`, `IMPLEMENTATION_STATUS.md`.

Launcher helpers are in `scripts/` (Node version check, rebuild check, open-browser-when-ready).

## Project status

Phase 1 (foundation) only. Features planned for later phases are listed in `TASKS.md`; they are not available yet.
