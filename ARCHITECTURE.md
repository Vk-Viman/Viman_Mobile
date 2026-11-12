# Architecture — Viman Mobile Shop System

This file describes how the system is built. The accounting rules are in `BUSINESS_RULES.md` (authoritative), tables in `DATABASE_SCHEMA.md`, endpoints in `API_CONTRACTS.md`, the owner's guide in `README.md`.

## Runtime

- Single Windows PC, single user, offline. `Start-Viman-Shop.bat` → `node server/src/index.ts` → `http://localhost:4300`, bound to `127.0.0.1` unless `VIMAN_HOST` says otherwise.
- Node.js ≥ 24. TypeScript is executed directly by Node's built-in type stripping (no server build step). Only *erasable* TypeScript is allowed (no `enum`, no `namespace`, no parameter properties); `erasableSyntaxOnly` enforces it.
- Relative imports in `server/` **must include the `.ts` extension** (`import { x } from './lib/money.ts'`).
- `npm ci` needs the internet once; afterwards nothing touches the network.
- Environment variables (`server/src/index.ts`): `VIMAN_DATA_DIR` (default `<project>/data`), `VIMAN_PORT` (default 4300), `VIMAN_HOST` (default `127.0.0.1`). Tests call `buildApp` directly with a temporary data folder.

## Layers (server)

```
routes/        thin: JSON-schema validation -> call a service -> shape the response
services/      business rules, transactions, audit logging (the authoritative math lives here)
repositories/  SQL only; take a DatabaseSync connection as first argument; no business rules
db/            connection wrapper (AppDatabase), tx helper, migration runner, migrations/*.sql
lib/           money (integer cents, basis points, rounding), dates, errors, report tables, limits
```

- Request flow: route (schema validation) → service (rules, one transaction, audit) → repository (SQL) → database. The database repeats the important rules as CHECKs and triggers, so a bug in a service cannot store a wrong figure (see `server/src/db/migrations/README.md`).
- Every multi-row financial write runs inside `AppDatabase.tx()` (`BEGIN IMMEDIATE … COMMIT`, `ROLLBACK` on error, savepoints when nested; async functions are refused because `node:sqlite` is synchronous). The business record, its stock movements, its cash entries, its Ice Cream fund entries and its audit row are committed together or not at all.
- The frontend never computes authoritative money figures. Forms show live previews with the same integer formulas, but the server's numbers are what is stored and shown after saving.
- Repositories are the swap point for a different database later; SQL is kept plain apart from `strftime`/`date` and SQLite triggers.

## Directory map

```
Start-Viman-Shop.bat        owner's launcher
scripts/                    check-node.mjs, needs-build.mjs, open-when-ready.mjs (used by the launcher)
data/                       created at run time: viman.db, backups/   (git-ignored)
server/src/
  index.ts                  entry point: damaged-file check, migrate, listen, temp cleanup, start-up backup
  app.ts                    composition root: Fastify, error envelope, routes under /api/v1, static web, SPA fallback
  db/                       db.ts, migrate.ts, migrations/001..014_*.sql (+ README.md)
  lib/                      money.ts, dates.ts, errors.ts, limits.ts, report-table.ts
  routes/                   one file per resource group (sales.ts, purchases.ts, icecream.ts, reports-*.ts, ...)
  services/                 *.service.ts per area; inventory.service.ts (stock engine); cash-posting.ts;
                            day-closing.ts; cash-warnings.ts; icecream-rules.ts (pure); reports/ (read-only report functions)
  repositories/             *.repo.ts, one per table group, plus sql-helpers.ts
  tests/                    *.test.ts (Vitest), finance/ (independent vectors), helpers/ (per-phase world builders)
web/src/
  main.tsx, App.tsx         entry and the route table
  layout/                   AppLayout, Sidebar, MobileMenu, navItems.ts
  pages/<area>/             one folder per sidebar item (sales, products, purchases, stock, ..., dashboard, reports, settings)
  components/               shared UI (Button, DataTable, FormDialog, MoneyInput, Tabs, ...)
  api/                      one file per resource group: typed fetch + TanStack Query hooks; client.ts holds the fetch wrapper
  types/                    TypeScript mirrors of the API responses
  lib/                      format.ts (Rs. formatting), units.ts (rupees <-> cents), errors.ts, amounts.ts, ...
```

## Data

- SQLite file `data/viman.db` (WAL, `foreign_keys=ON`, `synchronous=FULL`), backups in `data/backups/`.
- **Money:** integer cents. **Rates:** basis points (600 = 6.00%). **Quantities:** integer selling units. All arithmetic on money is integer arithmetic; any derived amount (commissions, proportional returns, removal values) goes through one helper, `mulDivRound(a, b, c) = round(a × b / c)`, computed exactly with BigInt, half away from zero, throwing `RangeError` if an input or the result is not a safe integer.
- **Display:** `Rs. 12,345.00`, negative `-Rs. 1,234.50` (`formatLKR`).
- **Migrations:** `server/src/db/migrations/NNN_name.sql`, applied in order, each in a transaction with its `schema_migrations` row. The checksum is SHA-256 of the file text with CRLF normalised to LF, so Windows checkouts do not change it. Editing an applied migration stops startup (`MIGRATION_CHECKSUM_MISMATCH`); a database newer than the program also stops it (`MIGRATION_DB_TOO_NEW`).

## Date rules

- **Business date** (`YYYY-MM-DD`, entered by the owner) drives every report and period. **Posting time** (`posted_at`, ISO UTC, set by the server, never editable) drives posting order: weighted-average costing, Ice Cream limits, D4 splits and the D2 void guard. Both are stored on every financial row and in its audit entry.
- The shop's calendar is **Asia/Colombo (UTC+5:30, no daylight saving)**. `todayBusinessDate()` gives today's date there; database triggers use `date('now','+330 minutes')`.
- **R-FD:** no business date after today (service check + triggers). Backdating is allowed and audited; backdated entries are listed in the Backdated report.
- **R-RD:** a return cannot be dated before its original sale or purchase (service check + triggers).
- **Reversals** copy the business date of the row they reverse, so a void lands in the same report period.
- Report and query dates (`asOf`, `from`, `to`) are never rejected for being in the future.

## Inventory and costing

- Per product, a cache of `qty_on_hand` and `stock_value_cents` (weighted average = value ÷ quantity, display only). **Every change is one `stock_movements` row**, and a database trigger applies it to the cache, so application code never writes the cache and "sum of movements = cache" cannot drift. `GET /inventory/reconciliation` checks it.
- All stock changes go through `services/inventory.service.ts`: `receiveStock` (inflow at an exact value), `issueStock` (outflow at `mulDivRound(value, qty, poolQty)`, or the whole remaining value when the whole quantity leaves; blocked above the quantity on hand), `issueStockCapped` (purchase return/void at the lower of the purchase value and the pool value, with a value-only `adjustment` sweep if value would be stranded at zero quantity), `reverseMovements` (exact negation for voids).
- The cost of a sale line is snapshotted on the line and never changes. An extra cost the cashier added (C13) is stored separately and never touches stock or cash.

## Ledgers

- **`cash_entries`** (append-only, signed amounts) is the only source of a cash book balance. Each entry names its book, and for Ice Cream exactly one fund. A void adds a reversal row (negated amount, same type, `reverses_entry_id`). `services/cash-posting.ts` (`postCash`, `reverseCash`) writes an entry and, for Ice Cream, its fund entry in the same transaction.
- **`icecream_fund_entries`** (append-only) is the fund ledger. Invariant: Σ fund entries = Σ Ice Cream cash entries = Cost + Electricity + Profit. Only a fund move writes a fund entry without a cash entry.
- **`stock_movements`** and **`audit_logs`** are append-only too. Business documents change only `posted → void`.
- **Ice Cream rules** (Charged/Settled/Unspent, profit-eligible limit, D4 split, D2 guard, excess cost) are one pure module, `services/icecream-rules.ts`, working on plain arrays loaded from posted rows. Nothing about them is stored as a running total.
- **Closed days:** `services/day-closing.ts` (`assertDayOpen`) is called by every write service for every book it touches; database triggers on `cash_entries` and the Ice Cream tables are the backstop.

## Reports and dashboard

Report services in `services/reports/` are read-only functions `(connection, query) → figures` using grouped SQL (no per-day query loops). The routes, the Excel export and the dashboard all call the same functions, so a dashboard figure always equals the matching report. Every report row uses only records whose business date falls inside that row's period.

## Backup and restore

- `VACUUM INTO` snapshot (consistent even in WAL mode; a plain file copy is unsafe because recent commits live in `viman.db-wal`), written to a temporary file and renamed.
- Start-up and manual backups keep the newest 30; pre-restore safety copies keep the newest 10.
- Restore gates: SQLite header → `integrity_check = ok` → `schema_migrations`, `settings`, `audit_logs` present → backup version ≤ program version → safety backup → close → atomic same-folder rename over `viman.db` (stale `-wal`/`-shm` removed) → reopen → migrate → audit entry. A failure after the swap began puts the safety backup back. While a restore runs every `/api` request gets `503 RESTORE_IN_PROGRESS`.

## Startup and crash safety

- `PRAGMA synchronous=FULL`: every committed entry is on disk before the API answers.
- Start-up order: read-only `PRAGMA quick_check` of an existing `viman.db` → open for writing and migrate → listen on the port → remove crash-leftover temp files → start-up backup. A damaged database (cannot open, or `quick_check` not `ok`) stops startup with step-by-step recovery instructions and the newest backup names. The damaged file is never opened for writing and never backed up, so damaged snapshots cannot rotate good backups away. Listening comes before the backup, so a second copy started by mistake fails on "port in use" without writing anything.
- The launcher itself checks Node.js, detects an already-running copy through `GET /health`, runs `npm ci` only when `node_modules` is missing, and rebuilds the web app only when a file under `web/src`, `web/index.html` or `web/vite.config.ts` is newer than `web/dist`.

## Web

- React 19 + Vite 7 + TypeScript + Tailwind 4 + TanStack Query 5 + React Router 7 + Lucide icons + Recharts 2.15 (dashboard charts).
- Production: `web/dist` is served by Fastify (`@fastify/static`) with an SPA fallback; `/api/*` and anything that looks like a file never fall back to HTML.
- Development: `npm run dev:server` (port 4300) + `npm run dev:web` (Vite on 5173, proxying `/api` to 4300).
- Sidebar order is defined in `layout/navItems.ts`; the route table is `App.tsx`. Each sidebar item is a folder in `pages/`; tabs are nested routes.

## Toolchain (versions installed in the last full run)

fastify 5.12 · @fastify/static 8.3 · @fastify/multipart 9.4 · exceljs 4.4 · typescript 5.9 · vitest 3.2 · vite 7.3 · react 19.3 · react-router 7.18 · @tanstack/react-query 5.107 · tailwindcss 4.3 · lucide-react 0.525 · recharts 2.15. Newer majors (TypeScript 7, Vite 8, Vitest 5, React Router 8) exist but were deliberately not adopted. A new dependency needs the owner's approval.

## Testing approach

- Vitest, `pool: 'forks'`, 20 s timeout, files in `server/src/tests/`. `npm test` runs the server suite only (81 files, 1,681 tests at the last full run). The web app has no test runner; it is checked by `npm run typecheck` and `npm run build`, and by manual browser passes.
- Every test builds its own server with `buildApp` on a fresh temporary data folder (`tests/helpers/tmp.ts`), so no test touches shop data. Per-phase helpers in `tests/helpers/` build realistic worlds through the real API.
- `tests/finance/` holds independent vectors: money rounding, weighted-average costing, COGS snapshots, extra cost, stock adjustments. Their expected numbers are computed by hand or by a separate model, never by calling the code under test.
- Typical layers: database tests (constraints and triggers directly on SQL), API tests (status codes, error codes, shapes, idempotency, voids, R-FD/R-RD, `DAY_CLOSED`), seeded random "model check" tests against an independent BigInt model, invariant tests (stock cache = movements, fund total = Ice Cream cash book), report tests (hand-calculated scenarios, additivity of rows, reconciliations), performance sanity tests on a seeded year, and the BUSINESS_RULES §10.8 Ice Cream worked example replayed step by step.
- Startup, backup, restore, damaged-file and static-file behaviour have their own tests (`startup`, `backups`, `restore`, `static`, `migrate`).

## How to add things

**A migration.** Create `server/src/db/migrations/NNN_name.sql` with the next number (three digits, lower-case name). Never edit an applied file. Follow the conventions in `DATABASE_SCHEMA.md`: `business_date` and `posted_at`, strict date CHECK, R-FD insert trigger, `<TABLE>_IMMUTABLE`/delete guard triggers, `client_ref UNIQUE`, explicit `IS NOT NULL` inside CHECKs that touch nullable columns. Document it in `server/src/db/migrations/README.md` and `DATABASE_SCHEMA.md`; run `npm test` (the migration test replays all files). A new table that must survive a restore check does not need to be added to `REQUIRED_TABLES` (it stays Phase 1 only; older backups are upgraded by `migrate()`).

**An endpoint.** Add a repository function (SQL only), a service function (validation, rules, `runWrite`/`database.tx`, audit via `logAudit`, cash and stock through the shared helpers, `assertDayOpen` for every touched book, `checkBusinessDate` for R-FD), and a route with a JSON schema (`additionalProperties: false`, patterns from `routes/catalog-query.ts`). Register the route file in `app.ts`. Every create takes `clientRef` and returns `200` with the original on a repeat. Add the endpoint to `API_CONTRACTS.md` and tests (happy path, validation, idempotency, void, closed day).

**A screen.** Add `web/src/types/<area>.ts` for the response shapes, `web/src/api/<area>.ts` for the fetch and query hooks, a folder `web/src/pages/<area>/` with the page and its tabs, register the nested routes in `App.tsx`, and add or update the item in `layout/navItems.ts`. Use the shared components, send money as integer cents (`lib/units.ts`), default dates to `GET /health` `today` with `max = today`, and show server error messages as they come.

**A report.** Add a pure function in `services/reports/` using grouped SQL and a `ReportTable`, a route using `parseReportQuery`/`sendReport` (`routes/report-common.ts`), then reuse the function in the dashboard or export pack if needed. Test it against a hand-calculated scenario.

## Change control

New rules, formulas or owner decisions are proposed to the owner and recorded in `BUSINESS_RULES.md` first; code and the other documents follow. Migrations are append-only. Documentation files are kept in step with the code: when a table, endpoint or screen changes, update `DATABASE_SCHEMA.md`, `API_CONTRACTS.md` and `README.md` in the same change.
