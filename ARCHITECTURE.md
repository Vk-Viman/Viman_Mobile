# Architecture — Viman Mobile Shop System

Source of truth: the approved *Final Architecture & Multi-Agent Plan*. This file summarises the technical shape; business rules live in `BUSINESS_RULES.md`, API in `API_CONTRACTS.md`, schema in `DATABASE_SCHEMA.md`.

## Runtime
- Single Windows PC, single user, offline. `Start-Viman-Shop.bat` → `node server/src/index.ts` → `http://localhost:4300` (bound to `127.0.0.1`).
- Node.js ≥ 24, TypeScript executed directly via Node's built-in type stripping (no server build step). Only *erasable* TS syntax is allowed (no `enum`, no `namespace`, no parameter properties) — enforced by `erasableSyntaxOnly`.
- Relative imports in `server/` **must include the `.ts` extension** (`import { x } from './lib/money.ts'`).
- `npm install` needs internet once; afterwards nothing touches the network.

## Layers (server)
```
routes/        thin: JSON-schema validation → call service → shape response
services/      business rules, transactions, audit logging (authoritative math lives here)
repositories/  SQL only; take a DatabaseSync connection as first argument; no business rules
db/            connection wrapper (AppDatabase), tx helper, migration runner, migrations/*.sql
lib/           money (integer cents, basis points, rounding), dates, errors
```
- Repositories are the swap point for a future MySQL implementation; keep SQL portable where reasonable (no SQLite-only tricks in business queries beyond `strftime`).
- Every multi-row financial write runs inside `AppDatabase.tx()` (BEGIN IMMEDIATE … COMMIT / ROLLBACK).
- The frontend never computes authoritative money figures; it only formats what the API returns.

## Data
- SQLite file `data/viman.db` (WAL mode, `foreign_keys=ON`), backups in `data/backups/`.
- Data directory is configurable with env `VIMAN_DATA_DIR` (tests use temp dirs). Port `VIMAN_PORT` (default 4300), host `VIMAN_HOST` (default 127.0.0.1).
- Money: integer cents. Rates: basis points (600 = 6.00%). Business dates `YYYY-MM-DD` (Asia/Colombo); timestamps ISO-8601 UTC.
- Migrations: `server/src/db/migrations/NNN_name.sql`, applied in order, each in a transaction, recorded with a SHA-256 checksum (computed on LF-normalised text so Windows CRLF checkouts don't change it). Editing an applied migration is refused at startup.

## Backup / restore
- `VACUUM INTO` snapshot (consistent even in WAL mode; a plain file copy is unsafe because recent commits live in `viman.db-wal`).
- Startup + manual backups (keep newest 30), pre-restore safety copies (keep newest 10).
- Restore gates: SQLite header → `integrity_check = ok` → `schema_migrations` present → version ≤ app version → required tables → safety backup → close → replace file (remove stale `-wal`/`-shm`) → reopen → migrate → audit log.

## Web
- React 19 + Vite 7 + TypeScript + Tailwind 4 + TanStack Query 5 + React Router 7 + Lucide. Recharts added in Phase 12.
- Production: `web/dist` served by Fastify (`@fastify/static`) with SPA fallback; `/api/*` never falls back to HTML.
- Dev: `npm run dev:server` (port 4300) + `npm run dev:web` (Vite 5173, proxies `/api` → 4300).

## Pinned toolchain (Phase 1)
fastify 5.12 · @fastify/static 8.3 · @fastify/multipart 9.4 · typescript 5.9 · vitest 3.2 · vite 7.3 · react 19.3 · react-router 7.18 · @tanstack/react-query 5.107 · tailwindcss 4.3 · lucide-react 0.525.
Newer majors (TS 7, Vite 8, Vitest 5, React Router 8) exist but were deliberately not adopted for Phase 1 stability. New dependencies require orchestrator approval.

## Multi-agent ownership
| Agent (Sonnet 5.5) | Owns |
|---|---|
| DB Architect | `server/src/db/**`, `server/src/repositories/**`, `DATABASE_SCHEMA.md` (implementation notes section) |
| Backend | `server/src/services/**`, `server/src/routes/**`, `server/src/lib/**`, `server/src/app.ts`, `server/src/index.ts` |
| Frontend | `web/**` except `web/package.json` |
| Financial Logic | `server/src/tests/finance/**`; reviews `BUSINESS_RULES.md` |
| QA | `server/src/tests/**` except `finance/` |
| Excel | `server/src/excel/**` (from Phase 13) |
| DevOps/Docs | `Start-Viman-Shop.bat`, `scripts/**`, `README.md`, `.gitignore` |
| Orchestrator (Opus 5.5) | root `package.json`, `tsconfig.base.json`, `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `web/package.json`, all contract docs, `TASKS.md`, `AGENT_WORK_LOG.md`, `IMPLEMENTATION_STATUS.md` |

## Startup & crash safety (Phase 1 final review)
- `PRAGMA synchronous=FULL`: every committed entry is on disk before the API answers (power cuts are common; NORMAL could lose the last commits).
- Startup order: **read-only `PRAGMA quick_check` of an existing `viman.db`** → open for writing + migrate → listen → remove crash-leftover temp files → startup backup. A damaged DB (cannot open, or quick_check ≠ ok) stops startup with step-by-step recovery instructions and the newest backup names. The damaged file is never opened for writing and no backup of it is taken (so damaged snapshots can never rotate good backups away).
- Restore swaps the validated candidate in with an atomic same-folder `rename`, never a partial copy.
- `audit_logs` is append-only at the database level (migration 002 triggers).
