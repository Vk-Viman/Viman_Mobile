# Database Schema

SQLite (`node:sqlite`), WAL, `foreign_keys=ON`, `synchronous=FULL` (every commit flushed to disk — protects the last entries against power cuts). Money = INTEGER cents, rates = INTEGER basis points, quantities = INTEGER selling units, business dates = TEXT `YYYY-MM-DD`, timestamps = TEXT ISO-8601 UTC (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`). Every FK column gets an index. Enumerations are enforced with `CHECK`. Ledger tables (`cash_entries`, `stock_movements`, `audit_logs`) are **append-only** (rule R1).

**Business date vs posting time (all financial tables, Phase 2+):** every business document and ledger row has `business_date TEXT NOT NULL` (owner-entered, `YYYY-MM-DD`, drives reports) **and** `posted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))` (server-set, immutable, drives posting order). In the planned tables below, `created_at` and ledger `at` **are** this `posted_at` column (to be named `posted_at` in the migrations). Indexes on `(business_date)` and `(posted_at)` for every financial table. A row is *backdated* when `business_date` < the Colombo date of `posted_at`; its audit row stores both. A **reversal** row copies the business_date of the row it reverses; its posted_at is the void time; the voided document's `voided_at` = that posted_at.

**No future business dates (R-FD, approved):** enforced first by the service layer (`business_date <= todayBusinessDate()` in Asia/Colombo → `FUTURE_DATE_NOT_ALLOWED`). As defence in depth every financial table gets, in its own migration, `BEFORE INSERT` and `BEFORE UPDATE OF business_date` triggers: `WHEN NEW.business_date > date('now', '+330 minutes') BEGIN SELECT RAISE(ABORT, 'FUTURE_DATE_NOT_ALLOWED'); END` (Colombo = UTC+5:30, no DST). A `CHECK` cannot be used because SQLite forbids non-deterministic `date('now')` in CHECK constraints. `posted_at` is server-set by its DEFAULT and never written by application code from user input; every non-ledger financial table also gets `BEFORE UPDATE OF posted_at … RAISE(ABORT, 'POSTED_AT_IMMUTABLE')` (append-only ledgers already forbid any update, so they need only the INSERT date trigger). Every financial table also gets the deterministic format check `CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date)`, so malformed or impossible dates (e.g. `2026-02-31`) can never be stored or mis-compared. The service error handler maps a SQLite `ABORT` with `FUTURE_DATE_NOT_ALLOWED` to `400` with the standard message. `audit_logs.business_date` is a copy of an already-validated date and gets no trigger.

**Returns not dated before the original (R-RD, approved):** enforced first by the service (`RETURN_BEFORE_ORIGINAL_DATE`), and in the database by triggers on the return headers — a CHECK cannot read another table, a trigger can: `sales_returns` `BEFORE INSERT` and `BEFORE UPDATE OF business_date, sale_id`: `WHEN NEW.business_date < (SELECT business_date FROM sales WHERE id = NEW.sale_id) BEGIN SELECT RAISE(ABORT, 'RETURN_BEFORE_ORIGINAL_DATE'); END`; the same on `purchase_returns` against `purchases.business_date` via `purchase_id`. The service maps the ABORT to `400` with the standard message. Return items inherit the header's date; the service also verifies every `sales_return_items.sale_item_id` belongs to the return's `sale_id` (and likewise for purchase return items) so the date comparison is always against the right original. Original documents' `business_date` is never edited after posting (void-and-replace only), so a later change cannot invalidate an existing return. **Defence in depth:** (a) `sales` and `purchases` get `BEFORE UPDATE OF business_date WHEN NEW.business_date <> OLD.business_date BEGIN SELECT RAISE(ABORT, 'BUSINESS_DATE_IMMUTABLE'); END` (correction = void-and-replace); (b) `sales_returns.sale_id` and `purchase_returns.purchase_id` are `NOT NULL`; (c) `sales_return_items` gets `BEFORE INSERT … WHEN (SELECT sale_id FROM sale_items WHERE id = NEW.sale_item_id) IS NOT (SELECT sale_id FROM sales_returns WHERE id = NEW.sales_return_id) BEGIN SELECT RAISE(ABORT, 'RETURN_ITEM_MISMATCH'); END`, and the same for `purchase_return_items` against `purchase_items`/`purchase_returns`; (d) BEFORE triggers run before CHECK constraints, so the service validates the date format (JSON schema + `isIsoDate`) before any write — the R-FD/R-RD triggers rely on well-formed `YYYY-MM-DD` text.

Migrations live in `server/src/db/migrations/NNN_name.sql`. Each phase adds its own migration; applied migrations are never edited.

| Migration | Phase | Status |
|---|---|---|
| `001_foundation.sql` | 1 | **implemented in Phase 1** |
| `002_audit_append_only.sql` | 1 (final review) | **implemented** — triggers block UPDATE/DELETE on `audit_logs` |
| `003_catalog.sql` … | 2+ | planned |
| Phase 8 migration (planned) | 8 | `ALTER TABLE audit_logs ADD COLUMN business_date TEXT NULL` + `ADD COLUMN backdated INTEGER NOT NULL DEFAULT 0` + index on `business_date` — additive; leaves 001/002 and the append-only triggers untouched |

---

## Phase 1 — `001_foundation.sql` (exact)

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,           -- NNN from the file name
  name        TEXT    NOT NULL,              -- file name, e.g. 001_foundation.sql
  checksum    TEXT    NOT NULL,              -- sha256 hex of LF-normalised file text
  applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY CHECK (key IN ('shop','rates','printDefaults')),
  value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  entity      TEXT    NOT NULL,              -- e.g. 'settings', 'backup', 'sale'
  entity_id   TEXT,                          -- id or key of the entity (text to allow keys)
  action      TEXT    NOT NULL,              -- e.g. 'update', 'create', 'void', 'restore', 'reopen'
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json  TEXT CHECK (after_json  IS NULL OR json_valid(after_json)),
  note        TEXT
);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity, entity_id);
CREATE INDEX idx_audit_logs_at     ON audit_logs(at);
```
Notes:
- The migration runner itself creates `schema_migrations` (IF NOT EXISTS) before reading it, so `001` must also use `IF NOT EXISTS` for that table.
- `settings.key` is restricted by CHECK; later phases that add keys must rebuild the CHECK via a new migration (SQLite cannot ALTER a CHECK — use table-rebuild pattern) **or** future keys go into new tables. Default values are applied by the service when a row is absent (no seed rows required).
- Audit rows are never updated or deleted — enforced by triggers `audit_logs_no_update` / `audit_logs_no_delete` (migration 002, `RAISE(ABORT, 'audit_logs is append-only')`).

---

## Planned tables (later phases; final DDL written in the phase's migration and reviewed by the orchestrator)

**Book** = `TEXT CHECK (book IN ('shop','telecom','icecream'))`. **Status** for business documents = `TEXT CHECK (status IN ('posted','void'))`.

### Phase 2 — catalog
- `categories(id, name UNIQUE, book shop|telecom, is_default, active, created_at, updated_at)` — 12 defaults: Phone Accessories, Tempered Glass, Phone Covers, Electronics, Stationery, Snacks and Drinks, Party Items, Perfume, Pooja Items, SIM, Other (shop) and Scratch Cards (telecom).
- `products(id, code UNIQUE NULL, name UNIQUE (case-insensitive), description, category_id FK, kind stock|service, book shop|telecom, sell_price_cents, min_price_cents, reorder_level, active, qty_on_hand, stock_value_cents, created_at, updated_at)` with `CHECK (qty_on_hand >= 0 AND stock_value_cents >= 0)`; `book` must equal its category's book (service rule).
- `suppliers(id, name UNIQUE, phone, notes, active, created_at, updated_at)`.

### Phase 3/4 — inventory
- `stock_movements(id, product_id FK, at, business_date, type opening|purchase|purchase_return|purchase_void|sale|sale_return|sale_void|personal_use|loss|stocktake_gain|stocktake_loss|adjustment, qty_delta, value_delta_cents, unit_cost_cents, ref_table, ref_id, reason)` — append-only; SUM(qty_delta)/SUM(value_delta_cents) per product must equal the product cache.
- `purchases(id, business_date, supplier_id FK NULL, bill_no, book, total_cents, status, client_ref UNIQUE, notes, created_at, voided_at, void_reason)`.
- `purchase_items(id, purchase_id FK, product_id FK, packs, pack_size, units, line_total_cents, returned_units)`.
- `purchase_returns(id, purchase_id FK, business_date, refund_cents, client_ref UNIQUE, created_at)` + `purchase_return_items(id, purchase_return_id FK, purchase_item_id FK, units, value_cents)`. — R-RD trigger: `business_date >= purchases.business_date`.
- `stocktakes(id, business_date, book, status draft|completed, notes, created_at, completed_at)` + `stocktake_items(id, stocktake_id FK, product_id FK, expected_qty, counted_qty, diff_qty, value_delta_cents)`.
- `stock_losses(id, business_date, product_id FK, book, qty, cost_cents, reason damaged|lost|expired|other, note, source manual|damaged_return, status, client_ref UNIQUE, created_at)`. — plus `sales_return_id FK NULL`, required iff `source = 'damaged_return'`; the loss row copies the return's `business_date` in the same transaction (R-RD/R-FD satisfied by construction).

### Phase 5 — sales
- `sales(id, business_date, book, total_cents, status, client_ref, notes, created_at, voided_at, void_reason)` — `UNIQUE(client_ref, book)` (one cart may split into a shop sale and a telecom sale).
- `sale_items(id, sale_id FK, line_no, line_type goods|card|print|service, product_id FK NULL, print_type_id FK NULL, description, qty, unit_price_cents, unit_cost_cents, revenue_cents, cogs_cents, returned_qty)`.
- `sales_returns(id, sale_id FK, business_date, refund_cents, client_ref UNIQUE, created_at)` + `sales_return_items(id, sales_return_id FK, sale_item_id FK, qty, resalable, revenue_cents, cogs_cents)`. — R-RD trigger: `business_date >= sales.business_date`.

### Phase 6/7 — telecom & printing
- `reload_providers(id, name UNIQUE, commission_bp, active)` — Dialog, Mobitel, Hutch, Airtel.
- `reload_sales(id, business_date, provider_id FK, sales_cents, commission_bp, commission_cents, extra_cents, status, client_ref UNIQUE, notes, created_at)`.
- `ezcash_sales(id, business_date, provider_id FK (Dialog), bill_total_cents, commission_bp, commission_cents, status, client_ref UNIQUE, notes, created_at)`.
- `telecom_topups(id, business_date, kind provider_topup|wallet_topup, provider_id FK, amount_cents, status, client_ref UNIQUE, notes, created_at)`.
- `print_service_types(id, code UNIQUE, name, price_cents, cost_cents, active)` — seeded from `settings.printDefaults`.
- `printing_supplies(id, business_date, amount_cents, description, status, client_ref UNIQUE, created_at)`.

### Phase 8/9 — money
**Electricity rule (P-2, approved):** enforced in the schema, not only in the API.
- `expenses(id, business_date, book, category, amount_cents, description, notes, status, client_ref UNIQUE, created_at)`
  - `CHECK (book IN ('shop','telecom'))` — Ice Cream never uses `expenses`.
  - `CHECK (category IN ('water','rent','internet','transport','repairs','cleaning_supplies','packaging','stationery','other'))` — **no `electricity` value exists** (E2).
- `cash_entries(id, book, business_date, at, type, amount_cents (signed), fund NULL, ref_table, ref_id, transfer_id NULL, reverses_entry_id NULL, note)` — append-only ledger (UPDATE/DELETE blocked by trigger, like `audit_logs`); balance = SUM(amount_cents) per book.
  - `fund` ∈ `cost|electricity|profit`, `CHECK ((book = 'icecream') = (fund IS NOT NULL))` — every Ice Cream cash movement names its fund; other books never do (BUSINESS_RULES §10.2).
  - `CHECK (type NOT LIKE 'icecream_%' OR book = 'icecream')` — Ice Cream entry types only in the Ice Cream book.
- `icecream_fund_entries` (defined under Phase 10 below) is **created in the Phase 8 migration together with `cash_entries`**, because Ice Cream opening balances, capital, drawings, transfers and over/short (Phases 8–9) must write both ledgers in one transaction from day one. Invariant Σ fund entries = Σ Ice Cream cash entries holds from Phase 8.
- `cash_transfers(id, business_date, from_book, to_book, from_fund NULL, to_fund NULL, amount_cents, status, client_ref UNIQUE, note, created_at, voided_at)` — `CHECK (from_book <> to_book)`; `from_fund` required iff `from_book='icecream'`, `to_fund` required iff `to_book='icecream'`.
- `cash_counts(id, book, business_date, counted_cents, expected_cents, difference_cents, fund NULL, note, status, client_ref UNIQUE, created_at, voided_at)` — over/short in the Ice Cream book names a fund.
- `daily_closings(id, book, business_date, expected_cents, counted_cents, over_short_cents, posted_at, closed_at, reopened_at, reopen_reason)` — `posted_at` = first closing time (server default, immutable); `closed_at` = the latest close after any reopen; `UNIQUE(book, business_date)`.
- `owner_drawings(id, business_date, book, fund NULL, kind cash|goods, amount_cents, product_id FK NULL, qty NULL, status, client_ref UNIQUE, note, created_at)` — `fund` required iff `book='icecream'`; `CHECK (NOT (kind = 'goods' AND book = 'icecream'))` (Ice Cream has no stock).
- `capital_entries(id, business_date, book, fund NULL, kind opening_balance|capital, amount_cents, status, client_ref UNIQUE, note, created_at)` — `fund` required iff `book='icecream'` (owner selects the destination fund each time; never profit-eligible).

### Phase 10 — ice cream
**Final design — BUSINESS_RULES §10 (P-1 approved 2026-11-10 with D1–D4).** Every write below happens in one transaction together with its `cash_entries` row (if cash moves), its `icecream_fund_entries` rows and an `audit_logs` row.
- `icecream_days(id, business_date, sales_cents, cost_alloc_cents, electricity_alloc_cents, profit_share_cents, negative_confirmed, notes, status, client_ref UNIQUE, created_at, voided_at)`
  - `CREATE UNIQUE INDEX ux_icecream_days_posted ON icecream_days(business_date) WHERE status = 'posted'` — one posted entry per date; voided rows are kept (void-and-replace).
  - `CHECK (profit_share_cents >= 0 OR negative_confirmed = 1)`
  - `CHECK (sales_cents >= 0 AND cost_alloc_cents >= 0 AND electricity_alloc_cents >= 0)`
  - `CHECK (cost_alloc_cents + electricity_alloc_cents + profit_share_cents = sales_cents)` — profit share is server-computed; negative only when `negative_confirmed = 1`.
- `icecream_sales(id, icecream_day_id FK, item_name, qty, unit_price_cents, line_total_cents)` — optional lines; must sum to `sales_cents`.
- `icecream_payments(id, business_date, kind materials|electricity_bill|other_cost, fund cost|electricity|profit, amount_cents > 0, category NULL, description, status, client_ref UNIQUE, created_at, voided_at)`
  - `CHECK (category IS NULL OR lower(trim(category)) <> 'electricity')` — the electricity bill is only ever `kind='electricity_bill'` (E4); the API applies the same case-insensitive check.
  - P&L treatment is derived, never chosen: `kind='other_cost' AND fund='profit'` → expense; everything else → settlement.
  - Settled attribution (BUSINESS_RULES §10.4): `materials` → Materials line; `electricity_bill` → Electricity line; `other_cost` from the Cost fund → Materials, from the Electricity fund → Electricity, from the Profit fund → none (expense).
- `icecream_fund_moves(id, business_date, from_fund, to_fund, amount_cents > 0, profit_effect_cents, charge_relabel_cents, cash_only_cents, status, client_ref UNIQUE, note, created_at, voided_at)` — `charge_relabel_cents` = Cost↔Electricity line re-label (§10.4); `cash_only_cents` = part of a move into Profit beyond the profit-eligible limit, posted only after owner confirmation (D4)
  - `CHECK (from_fund <> to_fund)`; `profit_effect_cents` = +profit-eligible amount (cost/electricity → profit, ≤ §10.4 limit), −amount (profit → cost/electricity), 0 (cost ↔ electricity) — server-computed; `CHECK`s enforce the sign rule and `profit_effect_cents + cash_only_cents = amount_cents` for moves into Profit.
  - Line state (Charged_L / Settled_L / Unspent_L) is derived from `icecream_days`, `icecream_payments` and `icecream_fund_moves` (posted rows) — never stored as a running total.
- `icecream_fund_entries(id, business_date, at, fund, amount_cents (signed), kind daily_allocation|payment|fund_move|drawing|transfer_out|transfer_in|opening_balance|capital|cash_over_short|reversal, ref_table, ref_id, reverses_entry_id NULL, note)` — append-only (trigger). Fund balance = SUM per fund.
  - **Invariant (tested):** Σ `icecream_fund_entries.amount_cents` (all funds) = Σ `cash_entries.amount_cents` where `book='icecream'`.
- `icecream_payments.kind` values map to cash-entry types: `materials` → `icecream_materials_payment`, `electricity_bill` → `icecream_electricity_payment`, `other_cost` → `icecream_other_cost`.
- A daily entry writes one `icecream_sale` cash entry (and one matching fund entry) per non-zero fund share, each naming its fund.
- Void guard (D2) and D3 excess cost are computed from posted rows at write/report time (no stored running totals).
- Removed vs the earlier plan: `icecream_expenses` and the `cost_adjustment` kind (C2 superseded by fund moves).

### Phase 13 — import
- `import_runs(id, kind opening_stock, file_name, rows_read, rows_accepted, rows_rejected, total_qty, total_value_cents, status previewed|imported|failed, created_at, imported_at)`.
- `import_issues(id, import_run_id FK, row_no, field, message)`.
