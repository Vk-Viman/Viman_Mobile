# Implementation Status

| Phase | Scope | Status |
|---|---|---|
| **1** | Foundation: DB + migrations, settings, audit log, backup/restore, web shell, launcher, docs | **☑ Complete (2026-11-10) — awaiting owner approval for Phase 2** |
| **2** | Catalog: categories, products, suppliers (migration 003, API, screens) | **☑ Complete (2026-11-10) — awaiting owner approval for Phase 3** |
| **3** | Purchases, stock movements, inventory engine, cash ledger table (migration 004) | **☑ Complete (2026-11-11) — awaiting owner approval for Phase 4** |
| 4–14 | See TASKS.md | not started |

## Phase 1 — what exists
- **Server** (`server/src`): Fastify on `127.0.0.1:4300`; SQLite via `node:sqlite` (WAL, foreign keys); migration runner with LF-normalised checksums; `001_foundation.sql` (`schema_migrations`, `settings`, `audit_logs`).
- **API** (`/api/v1`): `GET /health` · `GET/PUT /settings` (shop details, commission rates 600/80 bp, 7 print defaults) · `GET /audit-logs` (keyset paging) · `GET/POST /backups` · `POST /backups/restore` (by name or upload; typed `RESTORE`; 5 validation gates; safety backup; rollback on failure).
- **Money library**: integer cents, BigInt `mulDivRound` (half away from zero), basis points, `Rs. 12,345.00` formatting — ready for Phase 3+.
- **Web**: sidebar with all 13 sections (12 show "Available in Phase N"), Dashboard system-status card, Settings (General, Commission rates, Printing defaults, Backups, Audit log).
- **Launcher**: `Start-Viman-Shop.bat` (Node ≥ 24 check → already-running detection → `npm ci` if needed → rebuild if stale → server → opens browser when healthy).
- **Backups**: automatic at every start (after the port is secured), newest 30 kept; pre-restore safety copies newest 10.

## Verification evidence (2026-11-10)
- `npm test`: **11 files, 213 tests, all passing** (49 independent finance vectors + 164 QA) — after the final review.
- `npm run typecheck`: server + web clean. `npm run build`: success (JS 340 kB / 107 kB gzip, CSS 18 kB).
- **Cold start via `Start-Viman-Shop.bat`** with no `data/`: DB created, migrated to v1, startup backup written, health OK.
- **Browser (Playwright Chromium, 1366×768) at http://localhost:4300**: all 13 nav items; placeholder pages; deep-link SPA routing; General save → DB + audit row (before/after); rate `6.255` rejected client-side, `6.5` saved as 650 bp; Backup now; restore via dialog (button disabled until exactly `RESTORE`) → data reverted + safety backup; junk-file upload → "This file is not a Viman Mobile database. (RESTORE_INVALID_FILE)", data untouched; Esc closes dialog; audit tab lists all changes; restart via launcher → data persisted; rebuild while running → new assets served; **0 console errors**.
- Verification data was moved out of the project afterwards — the owner's first launch starts clean with default settings.

## Final review (2026-11-10)
- Fixed: power-cut durability (synchronous=FULL), DB-enforced append-only audit log (migration 002, schema v2), atomic restore swap, damaged-DB detection with read-only pre-flight + recovery instructions, crash temp-file cleanup, contract gaps. See AGENT_WORK_LOG.md FR-1…FR-7.
- **P-2 (electricity) approved and applied** across BUSINESS_RULES §7 (E1–E5), DATABASE_SCHEMA, API_CONTRACTS.
- **Final accounting rules approved 2026-11-10** (P-1 with D1–D4, P-2, and four confirmations); last Financial Logic consistency review: consistent after minor doc fixes. R-FD (no future-dated transactions; backdating allowed) approved and documented. R-RD (returns never dated before the original sale/purchase) approved and documented. Final documentation review: consistent; awaiting owner approval to start Phase 2.
- **P-1 (Ice Cream three-fund system) approved 2026-11-10 with D1–D4** and written into BUSINESS_RULES §10, DATABASE_SCHEMA (Phase 8–10 plans) and API_CONTRACTS (P8–P12). Implemented Phase 1 schema (v2) is unaffected; the fund tables arrive with Phases 8–10.
- Clean start re-verified via the launcher (schema v2, default 6% / 0.8%); verification data moved out of the project.

## Known limitations (Phase 1)
- No business features yet (products, sales, cash books, etc. arrive in Phases 2–14).
- Restore of a >200 MB upload and a true concurrent-restore 409 are not exercised by tests (the 503 guard is).
- The in-app Claude browser pane was hidden during verification; interactive checks ran in Playwright's Chromium against the same server.
- Launcher: if `node_modules` exists but is incomplete it does not self-repair (run `npm ci`); stale-build detection uses file timestamps of `web/src`, `index.html`, `vite.config.ts` only.
- Electricity / segment rules are documented (BUSINESS_RULES.md) but enforced only from Phase 8/10 when those tables exist.

## Phase 2 — Catalog (2026-11-10)
- **Database:** migration `003_catalog.sql` (schema v3): categories (12 seeded defaults, 11 shop + Scratch Cards telecom), products, suppliers; case-insensitive unique names/codes; CHECKs (prices, min ≤ sell, services hold no stock) and triggers (product book = category book, kind/book immutable, default categories locked, category book locked while it has products).
- **API:** `/api/v1/categories`, `/products` (search, filters, paging, lowStock), `/suppliers` — validated, no type coercion, every write audited in one transaction with its audit row; no-op edits write no audit row.
- **Web:** Products section with Products / Categories / Suppliers tabs.
- **Stock fields are read-only** (always 0 until Phase 3/4/13).
- **Tests:** 15 files, **299 passing** (86 new catalog tests; one Phase 1 startup test re-targeted to data pages because the new schema moved the corrupted byte range). Typecheck clean. Production build OK (363 kB JS).
- **Browser (Playwright, via Start-Viman-Shop.bat cold start):** product create, min > sell blocked with message, case-insensitive duplicate name rejected, default category locked ("Built-in category…"), owner category and supplier create, audit rows written, schema v3. Test data moved out afterwards.
- **Outstanding / notes:** empty product list shows two "New product" buttons (header + empty state); a PUT validates in order 404 → field validation → no-op → 409 rules; the Excel/Phase 13 and stock screens are not yet available.

## Phase 3 — Purchases, stock movements, inventory (2026-11-11)
- **Database (migration 004, schema v4):** `stock_movements` (append-only), `cash_entries` (append-only; created early by owner decision), `purchases`, `purchase_items`, `purchase_returns`, `purchase_return_items`, audit columns `business_date`/`backdated`. A trigger applies each inserted movement to the product's quantity/value, so the stock cache cannot drift from the movements and negative stock is blocked by the database itself. DB-level guards: future dates (R-FD), return before original date (R-RD), immutable business date / posting time, immutable purchases (only posted → void), return items must belong to their purchase.
- **Engine (`inventory.service`):** weighted-average pool — purchase adds exact value; removal at average (whole value when the whole pool leaves); purchase return/void remove min(purchase cost, pool value) with the leftover swept first (R4); reconciliation check.
- **API:** `/purchases` (create, list, get, void, returns), `/products/:id/movements`, `/inventory/reconciliation`; idempotent `clientRef`; every write one transaction (header, items, movements, cash entry, audit).
- **Web:** Purchases (list, new purchase with pack-size lines, detail, void with typed confirmation, return items) and per-product stock history.
- **Tests:** 19 files, **471 passing** (172 new: weighted-average 17, inventory-db 34, purchases-api 106, reconciliation 14 incl. a seeded 300-operation model check; two earlier tests updated for the new trigger/audit keys). Typecheck clean; production build OK.
- **Weighted-average demonstration (owner request):** purchase 10 @ Rs 3,000 then 10 @ Rs 4,000 → 20 units / Rs 7,000, avg Rs 350; sale of 2 → COGS Rs 700.00, pool 18 / Rs 6,300; purchase 5 @ Rs 420 → 23 / Rs 8,400 (avg 365.2174); sale of 3 → COGS Rs 1,095.65 (8,400×3÷23 = 1,095.652), pool 20 / Rs 7,304.35; selling the rest empties the pool to exactly 0/0. Sales are exercised through the engine only (sale endpoints arrive in Phase 5).
- **Browser (Playwright, cold start via launcher):** two purchases created through the screens (1×10 for Rs 3,000; 2×5 for Rs 4,000) → 20 units, Rs 7,000, avg Rs 350; partial return of 3 → refund Rs 900, pool 17/Rs 6,100; void with typed VOID → pool 7/Rs 2,100; reconciliation OK throughout; exact R-FD / R-RD messages returned by the API; stock history dialog; audit rows carry business date and backdated; 0 console errors. Test data moved out afterwards.
- **Outstanding / notes:** DAY_CLOSED and the negative-cash-balance warning arrive with the cash books (Phase 8); no screen shows the cash ledger yet (purchase payments/refunds are recorded in it); no sale/loss/stocktake/opening-stock endpoints until Phases 4–5/13; the product filter in the purchase form is a text box + select, not a combobox; a v3 database edited by hand to contain cached stock without movements would show as a reconciliation mismatch.
