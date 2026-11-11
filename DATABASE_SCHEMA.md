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
| `003_catalog.sql` | 2 | **implemented** — categories (+12 seeded defaults), products, suppliers + triggers |
| `004_purchases_inventory.sql` | 3 | **implemented** — stock_movements (+cache trigger), cash_entries, purchases, purchase_items, purchase_returns(+items), audit_logs columns |
| `005_stocktake_losses_drawings.sql` | 4 | **implemented** — stocktakes(+items), stock_losses, owner_drawings (goods only in Phase 4) |
| `006_sales_returns.sql` | 5 | **implemented** — sales, sale_items, sales_returns(+items), stock_losses.sales_return_id |
| `007_no_hard_deletes.sql` | 5 | BEFORE DELETE triggers (`RECORD_DELETE_FORBIDDEN`) on purchases(+items), stocktakes, stock_losses, owner_drawings, sales(+items) — BUSINESS_RULES §12 |

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

### Phase 2 — catalog (migration `003_catalog.sql`)
- `categories(id, name UNIQUE COLLATE NOCASE, book shop|telecom, is_default, active, created_at, updated_at)` — triggers: `BEFORE UPDATE OF name, book` on `is_default = 1` aborts `DEFAULT_CATEGORY_LOCKED`; `BEFORE UPDATE OF book` aborts `CATEGORY_HAS_PRODUCTS` when products exist — 12 defaults: Phone Accessories, Tempered Glass, Phone Covers, Electronics, Stationery, Snacks and Drinks, Party Items, Perfume, Pooja Items, SIM, Other (shop) and Scratch Cards (telecom).
- `products(id, code UNIQUE NULL, name UNIQUE (case-insensitive), description, category_id FK, kind stock|service, book shop|telecom, sell_price_cents, min_price_cents, reorder_level, active, qty_on_hand, stock_value_cents, created_at, updated_at)` with `CHECK (qty_on_hand >= 0 AND stock_value_cents >= 0)`, `CHECK (kind = 'stock' OR (qty_on_hand = 0 AND stock_value_cents = 0))`, `CHECK (sell_price_cents >= 0 AND min_price_cents >= 0 AND min_price_cents <= sell_price_cents AND reorder_level >= 0)`, `CHECK (code IS NULL OR length(code) > 0)`; `name` and `code` use `COLLATE NOCASE` unique constraints. Triggers: `BEFORE INSERT` / `BEFORE UPDATE OF category_id, book` abort `PRODUCT_BOOK_MISMATCH` unless `book` = the category's book; `BEFORE UPDATE OF kind, book` aborts `PRODUCT_KIND_IMMUTABLE` (kind and book never change after creation). Indexes: `category_id`, `(active, name)`.
- `suppliers(id, name UNIQUE COLLATE NOCASE, phone, notes, active, created_at, updated_at)`. The 12 default categories are seeded by the migration (`is_default = 1`). Restore validation keeps requiring only the Phase 1 tables (`REQUIRED_TABLES`), because later tables arrive via `migrate()` after a restore.

### Phase 3 — purchases, stock movements, cash ledger (migration `004_purchases_inventory.sql`, detail)
Implements the planned tables below for Phase 3 (`stocktakes`, `stock_losses` stay Phase 4) plus the **cash ledger created early** (owner decision 2026-11-10). Common rules from the conventions above apply to every table here: `business_date` + `posted_at` (server default, immutable), strict date-format CHECK, R-FD `BEFORE INSERT` trigger (`FUTURE_DATE_NOT_ALLOWED`).

- **`stock_movements`** (`id, product_id FK NOT NULL, business_date, posted_at, type CHECK IN (the 12 types), qty_delta, value_delta_cents, unit_cost_cents NULL, ref_table NULL, ref_id NULL, reason`) — `CHECK (qty_delta <> 0 OR value_delta_cents <> 0)`; **append-only** (`BEFORE UPDATE`/`BEFORE DELETE` abort `stock_movements is append-only`); index `(product_id, posted_at)`, `(business_date)`.
- **Stock cache trigger:** `AFTER INSERT ON stock_movements` → `UPDATE products SET qty_on_hand = qty_on_hand + NEW.qty_delta, stock_value_cents = stock_value_cents + NEW.value_delta_cents WHERE id = NEW.product_id`. The Phase 2 CHECKs (qty ≥ 0, value ≥ 0, services hold no stock) abort any movement that would break them. Extra backstop: `BEFORE UPDATE OF qty_on_hand, stock_value_cents ON products WHEN NEW.qty_on_hand = 0 AND NEW.stock_value_cents <> 0` → abort `STOCK_VALUE_WITHOUT_QTY` (the R4 residual sweep is written *before* the removal).
- **`cash_entries`** (`id, book CHECK IN ('shop','telecom','icecream'), business_date, posted_at, type CHECK IN (all 24 types in BUSINESS_RULES §2), amount_cents, fund NULL, ref_table NULL, ref_id NULL, transfer_id NULL, reverses_entry_id NULL FK, note NULL`) — `CHECK ((book = 'icecream') = (fund IS NOT NULL))`, `CHECK (type NOT LIKE 'icecream_%' OR book = 'icecream')`, `CHECK (type NOT IN ('purchase_payment','purchase_refund') OR book IN ('shop','telecom'))`; append-only triggers; indexes `(book, business_date)`, `(ref_table, ref_id)`. A reversal is a new row with the negated amount, the same type, `reverses_entry_id` set and the original's `business_date`. Phase 3 writes only `purchase_payment` / `purchase_refund`.
- **`purchases`** (`id, business_date, posted_at, supplier_id FK NULL, bill_no TEXT NOT NULL DEFAULT '', book CHECK IN ('shop','telecom'), total_cents >= 0, status CHECK IN ('posted','void') DEFAULT 'posted', client_ref UNIQUE NOT NULL, notes DEFAULT '', voided_at NULL, void_reason NULL`) — `CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))`. Triggers: `BUSINESS_DATE_IMMUTABLE`, `POSTED_AT_IMMUTABLE`, `PURCHASE_IMMUTABLE` (any change to supplier, bill_no, book, total, notes, client_ref aborts; only `status`/`voided_at`/`void_reason` may change, and only `posted → void`). Indexes `(business_date)`, `(supplier_id)`, `(book, business_date)`.
- **`purchase_items`** (`id, purchase_id FK NOT NULL, product_id FK NOT NULL, packs >= 1, pack_size >= 1, units, line_total_cents >= 0, returned_units DEFAULT 0`) — `CHECK (units = packs * pack_size)`, `CHECK (returned_units BETWEEN 0 AND units)`; trigger `PURCHASE_ITEM_IMMUTABLE` (only `returned_units` may change, never decrease). Indexes `(purchase_id)`, `(product_id)`.
- **`purchase_returns`** (`id, purchase_id FK NOT NULL, business_date, posted_at, refund_cents >= 0, note DEFAULT '', client_ref UNIQUE NOT NULL`) — R-RD triggers (`BEFORE INSERT`, `BEFORE UPDATE OF business_date, purchase_id`: `business_date < purchases.business_date` → abort `RETURN_BEFORE_ORIGINAL_DATE`); also abort `PURCHASE_VOID` on insert when the purchase is void. Append-only (no UPDATE/DELETE).
- **`purchase_return_items`** (`id, purchase_return_id FK NOT NULL, purchase_item_id FK NOT NULL, units >= 1, value_cents >= 0`) — `BEFORE INSERT` trigger `RETURN_ITEM_MISMATCH` unless the item belongs to the return's purchase; append-only.
- **`audit_logs`** (additive, `ALTER TABLE … ADD COLUMN`): `business_date TEXT NULL`, `backdated INTEGER NOT NULL DEFAULT 0`; index on `business_date`. The append-only triggers from migration 002 are untouched.
- Restore validation (`REQUIRED_TABLES`) stays Phase 1 only.

### Phase 4 — stocktakes, stock losses, owner drawings (migration `005_stocktake_losses_drawings.sql`, detail)
Same common rules as Phase 3 (business date + immutable `posted_at`, strict date CHECK, R-FD `BEFORE INSERT` trigger, `BUSINESS_DATE_IMMUTABLE`, `POSTED_AT_IMMUTABLE`). `owner_drawings` is created now (planned for Phases 8/9) because personal-use stock must be recorded as an owner drawing in Phase 4; Phase 4 writes only `kind = 'goods'`.
- **`stocktakes`** (`id, business_date, posted_at, book CHECK IN ('shop','telecom'), status CHECK IN ('draft','completed','void') DEFAULT 'draft', notes DEFAULT '', client_ref UNIQUE NOT NULL, completed_at NULL, voided_at NULL, void_reason NULL`) — `CHECK (status <> 'void' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))`, `CHECK (status <> 'completed' OR completed_at IS NOT NULL)`. Trigger `STOCKTAKE_TRANSITION`: only `draft → completed`, `draft → void`, `completed → void` are allowed; `notes` may change only while `draft`; `book`, `client_ref`, dates never change. Indexes `(business_date)`, `(book, status)`.
- **`stocktake_items`** (`id, stocktake_id FK NOT NULL, product_id FK NOT NULL, counted_qty >= 0, expected_qty NULL, difference_qty NULL, value_delta_cents NULL, gain_unit_cost_cents NULL >= 0`) — `UNIQUE (stocktake_id, product_id)`; triggers: `INSERT`/`DELETE` and `UPDATE OF counted_qty, product_id, gain_unit_cost_cents` only while the parent is `draft` (`STOCKTAKE_NOT_DRAFT`); `UPDATE OF expected_qty, difference_qty, value_delta_cents` allowed only while the parent is `draft` (completion fills them before the status flips); product must be `kind = 'stock'` and of the stocktake's book (`PRODUCT_NOT_IN_BOOK`). Index `(product_id)`.
- **`stock_losses`** (`id, business_date, posted_at, product_id FK NOT NULL, book CHECK IN ('shop','telecom'), qty >= 1, cost_cents >= 0, reason CHECK IN ('damaged','lost','expired','other'), note DEFAULT '', source CHECK IN ('manual','damaged_return') DEFAULT 'manual', status CHECK IN ('posted','void') DEFAULT 'posted', client_ref UNIQUE NOT NULL, voided_at NULL, void_reason NULL`) — `CHECK (status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))`; trigger `STOCK_LOSS_IMMUTABLE` (only `status`/`voided_at`/`void_reason`, only `posted → void`). `sales_return_id` is added by the Phase 5 migration (`ALTER TABLE … ADD COLUMN … REFERENCES sales_returns(id)`). Indexes `(business_date)`, `(product_id)`, `(book, reason)`.
- **`owner_drawings`** (`id, business_date, posted_at, book CHECK IN ('shop','telecom','icecream'), fund NULL, kind CHECK IN ('cash','goods'), amount_cents >= 0, product_id FK NULL, qty NULL, note DEFAULT '', status CHECK IN ('posted','void') DEFAULT 'posted', client_ref UNIQUE NOT NULL, voided_at NULL, void_reason NULL`) — `CHECK ((book = 'icecream') = (fund IS NOT NULL))`, `CHECK (NOT (kind = 'goods' AND book = 'icecream'))`, `CHECK (kind <> 'goods' OR (product_id IS NOT NULL AND qty >= 1))`, `CHECK (kind <> 'cash' OR (product_id IS NULL AND qty IS NULL))`, void CHECK as above; same immutability trigger style (`OWNER_DRAWING_IMMUTABLE`). Indexes `(business_date)`, `(kind, status)`, `(product_id)`.
- Stock cache, reversal rows and append-only rules are unchanged from Phase 3. Movement `ref_table` values used: `'stocktakes'`, `'stock_losses'`, `'owner_drawings'`. Restore validation (`REQUIRED_TABLES`) stays Phase 1 only.

### Phase 3/4 — inventory (planned columns; Phase 3 detail above supersedes where it differs)
- `stock_movements(id, product_id FK, at, business_date, type opening|purchase|purchase_return|purchase_void|sale|sale_return|sale_void|personal_use|loss|stocktake_gain|stocktake_loss|adjustment, qty_delta, value_delta_cents, unit_cost_cents, ref_table, ref_id, reason)` — append-only; SUM(qty_delta)/SUM(value_delta_cents) per product must equal the product cache.
- `purchases(id, business_date, supplier_id FK NULL, bill_no, book, total_cents, status, client_ref UNIQUE, notes, created_at, voided_at, void_reason)`.
- `purchase_items(id, purchase_id FK, product_id FK, packs, pack_size, units, line_total_cents, returned_units)`.
- `purchase_returns(id, purchase_id FK, business_date, refund_cents, client_ref UNIQUE, created_at)` + `purchase_return_items(id, purchase_return_id FK, purchase_item_id FK, units, value_cents)`. — R-RD trigger: `business_date >= purchases.business_date`.
- `stocktakes(id, business_date, book, status draft|completed, notes, created_at, completed_at)` + `stocktake_items(id, stocktake_id FK, product_id FK, expected_qty, counted_qty, diff_qty, value_delta_cents)`.
- `stock_losses(id, business_date, product_id FK, book, qty, cost_cents, reason damaged|lost|expired|other, note, source manual|damaged_return, status, client_ref UNIQUE, created_at)`. — plus `sales_return_id FK NULL`, required iff `source = 'damaged_return'`; the loss row copies the return's `business_date` in the same transaction (R-RD/R-FD satisfied by construction).

### Phase 5 — sales, sales returns, damaged-return losses (migration `006_sales_returns.sql`, detail)
Same common rules as Phases 3–4 (business date + immutable `posted_at`, strict date CHECK, R-FD `BEFORE INSERT` trigger, `BUSINESS_DATE_IMMUTABLE`, `POSTED_AT_IMMUTABLE`). **NULL-in-CHECK:** write explicit `IS NOT NULL` where a nullable column is compared.
- **`sales`** (`id, business_date, posted_at, book CHECK IN ('shop','telecom'), total_cents >= 0, status CHECK IN ('posted','void') DEFAULT 'posted', notes DEFAULT '', client_ref NOT NULL, voided_at NULL, void_reason NULL`) — `UNIQUE (client_ref, book)` (one cart may create a shop sale and a telecom sale), void CHECK (void ⇒ `voided_at` and `void_reason` set). Trigger `SALE_IMMUTABLE`: only `status`/`voided_at`/`void_reason` may change, only `posted → void`. Indexes `(business_date)`, `(book, business_date)`.
- **`sale_items`** (`id, sale_id FK NOT NULL, line_no >= 1, line_type CHECK IN ('goods','card') (print/service added in Phase 7), product_id FK NOT NULL, description NOT NULL, qty >= 1, unit_price_cents >= 0, unit_cost_cents >= 0, revenue_cents >= 0, cogs_cents >= 0, returned_qty DEFAULT 0`) — `CHECK (revenue_cents = qty * unit_price_cents)`, `CHECK (returned_qty BETWEEN 0 AND qty)`, `UNIQUE (sale_id, line_no)`; trigger `SALE_ITEM_IMMUTABLE` (only `returned_qty` may change, never decrease); trigger `SALE_ITEM_BOOK_MISMATCH` (line type goods ⇔ shop sale, card ⇔ telecom sale; product's book = the sale's book). Indexes `(sale_id)`, `(product_id)`.
- **`sales_returns`** (`id, sale_id FK NOT NULL, business_date, posted_at, refund_cents >= 0, cogs_reversed_cents >= 0, note DEFAULT '', client_ref UNIQUE NOT NULL`) — **R-RD** triggers: `business_date < sales.business_date` → abort `RETURN_BEFORE_ORIGINAL_DATE`; insert on a void sale → abort `SALE_VOID`; append-only (no UPDATE/DELETE).
- **`sales_return_items`** (`id, sales_return_id FK NOT NULL, sale_item_id FK NOT NULL, qty >= 1, resalable CHECK IN (0,1), revenue_cents >= 0, cogs_cents >= 0`) — trigger `RETURN_ITEM_MISMATCH` (the item must belong to the return's sale); a trigger rejects a return quantity above `sold − returned` (`RETURN_EXCEEDS_SOLD`) as a backstop; append-only.
- **`stock_losses`** (additive): `ALTER TABLE stock_losses ADD COLUMN sales_return_id INTEGER REFERENCES sales_returns(id)`; triggers: `BEFORE INSERT` abort `DAMAGED_RETURN_LINK` unless `(source = 'damaged_return') = (sales_return_id IS NOT NULL)`; for `damaged_return` rows `business_date` must equal the return's (`DAMAGED_RETURN_DATE`) and `reason = 'damaged'`; index `(sales_return_id)`. Phase 4's `STOCK_LOSS_IMMUTABLE` is unchanged.
- Movements used: `sale` (`ref_table = 'sales'`), `sale_return` (`ref_table = 'sales_returns'`). Cash types used: `sale_goods`, `card_sale`, `sale_refund`, `card_refund`. Restore validation (`REQUIRED_TABLES`) stays Phase 1 only.

### Phase 5 — sales (planned columns; the Phase 5 detail above supersedes where it differs)
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
- `cash_entries` itself is **created early, in Phase 3 (migration 004)**, with the `fund` column and constraints below; Phase 8 adds the other entry types' writers, opening balances and screens. `icecream_fund_entries` (defined under Phase 10 below) is **created in the Phase 8 migration** before any Ice Cream cash entry can be written, because Ice Cream opening balances, capital, drawings, transfers and over/short (Phases 8–9) must write both ledgers in one transaction from day one. Invariant Σ fund entries = Σ Ice Cream cash entries holds from Phase 8.
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
