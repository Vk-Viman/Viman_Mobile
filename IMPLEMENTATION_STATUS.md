# Implementation Status

| Phase | Scope | Status |
|---|---|---|
| **1** | Foundation: DB + migrations, settings, audit log, backup/restore, web shell, launcher, docs | **☑ Complete (2026-11-10) — awaiting owner approval for Phase 2** |
| **2** | Catalog: categories, products, suppliers (migration 003, API, screens) | **☑ Complete (2026-11-10) — awaiting owner approval for Phase 3** |
| **3** | Purchases, stock movements, inventory engine, cash ledger table (migration 004) | **☑ Complete (2026-11-11) — awaiting owner approval for Phase 4** |
| **4** | Stocktake, stock losses, personal-use drawings (goods), inventory valuation (migration 005) | **☑ Complete (2026-11-11) — awaiting owner approval for Phase 5** |
| **5** | POS, sales, sales returns, voids (migrations 006–007) | **☑ Complete (2026-11-11) — awaiting owner approval for Phase 6** |
| 6–14 | See TASKS.md | not started |

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

## Phase 4 — Stocktake, stock losses, personal use, valuation (2026-11-11)
- **Database (migration 005, schema v5):** `stocktakes` (+items), `stock_losses`, `owner_drawings` (created now; only goods drawings written until Phase 9) with date/R-FD guards, status-transition and immutability triggers. All stock changes still go through the Phase 3 movement ledger and cache trigger.
- **Stocktake:** draft count sheet (live system quantities) → complete posts differences: loss at weighted average, gain at the average (C10: entered unit cost required when the pool has no quantity or value). Voiding a completed stocktake writes exact negations on the original business date; blocked if gained stock was already used.
- **Stock losses:** damaged / lost / expired / other at average cost; one loss row ↔ exactly one movement; idempotent; void restores stock and value exactly.
- **Personal use:** goods drawing at cost (not selling price), no cash, no revenue/COGS/expense, never in stock losses; void restores stock.
- **Valuation:** `GET /inventory/valuation` (live or as of a business date, Shop and Telecom separate).
- **Web:** Stock section — Stock on hand (valuation + reconciliation check), Stocktake (count sheet), Stock losses, Personal use.
- **Tests:** 27 files, **607 passing** (136 new, incl. a seeded 1,200-operation model check against an independent BigInt model). QA found a real DB bug (NULL quantity slipped through a goods-drawing CHECK) — fixed in migration 005 before release. Typecheck clean, production build OK.
- **Browser (Playwright, cold start via launcher):** valuation screen (Shop vs Telecom separate); count sheet counted 17 vs system 20 → loss Rs 1,050 at average, pool 17 / Rs 5,950; damaged loss of 2 → Rs 700; personal use of 1 → drawing Rs 350 (not Rs 1,000), not in losses; void stocktake → exact reversal; exact R-FD message; over-removal blocked; backdated loss accepted and audited; reconciliation OK; 0 console errors. Test data moved out afterwards.
- **Outstanding / notes:** valuation as of a date before any purchase can show negative quantity when a loss was backdated before the stock existed (a plain sum of movements by business date — allowed by the backdating rule); no opening-stock entry yet (Phase 13), so existing inventory is entered via purchases; stock-adjustment totals (losses + stocktake differences) are derivable from movements and appear in the Phase 11 reports; unknown product ids return 400 (as in Phase 3).

## Phase 5 — POS, sales, returns, voids (2026-11-11)
- **Database (schema v7):** migration 006 — `sales`, `sale_items`, `sales_returns`(+items), `stock_losses.sales_return_id`; guards for future dates, return-before-sale dates, over-return, immutability, damaged-return link/date/reason. Migration 007 — `BEFORE DELETE` triggers (`RECORD_DELETE_FORBIDDEN`) on purchases, stocktakes, stock losses, drawings, sales and their lines (BUSINESS_RULES §12; found by QA).
- **Sales:** one cart → one sale per book (Shop goods → `sale_goods`, Telecom scratch cards → `card_sale`); lines sold in cart order at the weighted average with the unit cost **snapshotted** (never changes after later purchases); stock, cash entry and audit saved in one transaction; R13 warnings never block; duplicate submission returns the original.
- **Returns:** exact C5 split (the last return takes the remainder of revenue and COGS); resalable → stock back at the original snapshot cost; damaged → no restock, revenue and COGS reversed, exactly one stock-loss row; refund cash entry; return date ≥ sale date and ≤ today.
- **Voids:** exact reversal of movements and cash (original business date); blocked when the sale has returns.
- **Web:** Sales section — POS (search, cart, per-book subtotals, price warnings, result panel, today's sales) and History (filters, totals, detail, returns, void).
- **Code quality pass (before Phase 5):** comments across all server, web and test code with business-rule references; shared helpers/components extracted; migrations 001–005 untouched; migrations README.
- **Tests:** 35 files, **751 passing** (144 new: sales-db 24, COGS snapshot 22, sales API 39, returns 31, voids 18, seeded 3×300-operation model check, persistence 3, delete guards 2). Typecheck clean; production build OK.
- **Browser (Playwright, via Start-Viman-Shop.bat):** mixed cart → Shop sale (2 @ Rs 1,000, COGS Rs 700) + Telecom sale (3 cards @ Rs 100, COGS Rs 291); below-minimum price warns but sells; later purchase moved the average to Rs 365.22 while the old sale's COGS stayed Rs 700; resalable return restored stock value by exactly Rs 350; damaged return left stock unchanged and created one loss of Rs 350; void restored stock exactly; exact R-FD / R-RD / over-sell messages; duplicate submission returned the original (200); reconciliation OK; 0 console errors.
- **Outstanding / notes:** service/printing lines (Phase 7) and reloads (Phase 6) are not sellable yet; `DAY_CLOSED` and the negative-cash warning arrive with the cash books (Phase 8); a repeated cart after a void returns the (void) original sale by design (`UNIQUE(client_ref, book)`); revenue never needs the C5 remainder (price × qty is exact) — the remainder only affects COGS. **Git:** the history was rewritten to remove the AI co-author lines and **published** (force-push to `main` approved by the owner on 2026-11-11); `main` on GitHub and locally both point to the same commit, and Phases 1-5 are merged through PRs #1-#3. Two old merged remote branches (`feature/phase-2-3-catalog-purchases`, `feature/phase-4-stocktake-losses-valuation`) still exist and still carry the old commits; deleting them is a **separate owner decision**. A local safety branch `backup-before-rewrite` keeps the pre-rewrite history on this computer only.

## Housekeeping check (2026-11-11, before Phase 6)
- Local and remote `main` identical; working tree clean; no `data/` folder in the project (first launch starts with an empty database containing only the 12 built-in categories).

## Phase 5 amendment — editable sale cost / extra cost, rule C13 (2026-11-11)
- **Owner rule C13:** a sale line's cost fills in automatically at the weighted-average value; the cashier may **raise** it (never lower) — e.g. automatic Rs 37.40 → Rs 38. Profit uses the cost charged; the difference is the line's **extra cost**, shown under cost and included whenever cost is calculated. Stock leaves at the true average (stock and reconciliation unaffected); no stock movement, cash entry or balance for the extra.
- **Database (schema v8):** migration 008 — `extra_cost_cents` on sale items and return items, `extra_cost_reversed_cents` on returns, immutability trigger, over-reversal backstop. Migrations 001–007 untouched.
- **API:** optional `unitCostCents` per cart line; `COST_BELOW_AUTOMATIC` (422, nothing saved, message names the minimum); sales/returns/totals gain extra-cost fields; returns reverse the extra with the same exact-remainder split (C5); resalable returns restock and damaged-return losses use the automatic cost only.
- **Web:** POS cart "Cost per unit" field (auto-filled, raise only), extra cost shown on the result, history, detail and returns.
- **Tests:** 38 files, **798 passing** (47 new). Typecheck clean; production build OK.
- **Browser (Playwright, launcher cold start):** charger with automatic Rs 37.40: cost field auto-filled; Rs 37 refused ("can only be increased", Save disabled); Rs 38 on 5 units → extra Rs 3.00, cost Rs 190.00 (automatic Rs 187.00 + extra Rs 3.00), profit Rs 310; stock left at Rs 187.00; return of 2 reversed extra Rs 1.20 and restocked at the automatic Rs 74.80; reconciliation OK; 0 console errors.

## Wave 1 — Phases 6, 7, 13 (started 2026-11-11, owner authorised Phases 6–14 in waves)
- Branch `feature/wave1-telecom-printing-opening-stock`; baseline commit `5acfe73` (ExcelJS 4.4.0, stubs, contracts).
- Parallel agents, each in its own git worktree with exclusive files: Phase 6 telecom (migration 009), Phase 7 printing (010), Phase 13 opening stock/Excel (011). Orchestrator owns all `.md` docs, `app.ts`, `App.tsx`, `navItems.ts`.
- Status: **built and integrated** — Phase 6 (109 new tests), Phase 7 (84), Phase 13 (136); merged tree: typecheck (server+web) clean, **1,127 tests passing, 0 skipped** (798 baseline), web build OK. Phase 6 and 13 agents ran browser smoke tests; the combined launcher-based browser pass for Waves 1–4 is scheduled for Phase 14.
- Not yet built (later waves): DAY_CLOSED enforcement (R9, Phase 8), Phase 11 printing variance report, date-check trigger follow-up (see migrations README).

## Wave 2 — Phase 8 (2026-11-11) — built and integrated
Migration 012; expenses, opening balances, cash counts, daily closings, DAY_CLOSED across all write services, shared negative-cash/fund warnings, Ice Cream fund ledger table, invalid-date triggers. Merged tree: typecheck (server+web) clean, **1,264 tests pass, 0 skipped** (1,127 + 137 new), web build OK; agent browser smoke test passed (opening balance, closing with Rs 500 short, DAY_CLOSED message, negative-cash toast, Ice Cream fund tiles). Existing test changes (5 files) re-derived and accepted. Launcher-based combined browser pass is scheduled for Phase 14.
