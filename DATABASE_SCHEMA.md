# Database Schema

As built: migrations `001`–`014` (schema version **14**). This file is the single reference for the tables, columns, constraints and triggers that exist today. The migration files in `server/src/db/migrations/` are the source of truth; `server/src/db/migrations/README.md` explains why each file exists. If this file and a migration disagree, the migration wins and this file is wrong.

SQLite (`node:sqlite`), WAL mode, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=FULL` (every commit is flushed to disk, which protects the last entries against power cuts). 40 tables.

## Conventions

- **Money** = INTEGER cents. **Rates** = INTEGER basis points (600 = 6.00%). **Quantities** = INTEGER selling units. **Business dates** = TEXT `YYYY-MM-DD`. **Timestamps** = TEXT ISO-8601 UTC, written by SQLite as `strftime('%Y-%m-%dT%H:%M:%fZ','now')`.
- **Booleans** are INTEGER 0/1 with `CHECK (x IN (0,1))`. Enumerations are `CHECK (x IN (...))`.
- **Book** = `shop` | `telecom` | `icecream`. **Fund** (Ice Cream only) = `cost` | `electricity` | `profit`. **Status** of a business record = `posted` | `void`.
- **Business date vs posting time (BUSINESS_RULES §12).** Every financial table has `business_date` (owner-entered, drives reports) and `posted_at` (server default, drives posting order). A row is *backdated* when `business_date` is earlier than the Colombo date of `posted_at`. `posted_at` is never supplied by application code from user input; a `POSTED_AT_IMMUTABLE` trigger protects it on the non-ledger tables (ledger tables forbid every update anyway).
- **Strict date CHECK.** Every business-date column has `CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(business_date) = business_date)`. Migrations 010 and later also add `date(x) IS NOT NULL`. In SQLite a CHECK that evaluates to NULL passes, so `2020-13-01` slipped through the older form; migration 012 closed the gap with `INVALID_BUSINESS_DATE` triggers (see below).
- **R-FD (no future dates).** `BEFORE INSERT` trigger `trg_<table>_future_date` aborts with `FUTURE_DATE_NOT_ALLOWED` when `business_date > date('now','+330 minutes')` (Colombo is UTC+5:30, no daylight saving). A CHECK cannot be used because SQLite forbids non-deterministic `date('now')` there. The services check first and give the friendly message; the trigger is the backstop. Tables with this trigger: `stock_movements`, `cash_entries`, `purchases`, `purchase_returns`, `stocktakes`, `stock_losses`, `owner_drawings`, `sales`, `sales_returns`, `reload_sales`, `ezcash_sales`, `telecom_topups`, `print_sales`, `printing_supplies`, `opening_stock_batches`, `expenses`, `capital_entries`, `cash_counts`, `daily_closings`, `icecream_fund_entries`, `cash_transfers`, `icecream_days`, `icecream_payments`, `icecream_fund_moves`. `import_runs` has only the `INVALID_BUSINESS_DATE` trigger (the import service applies R-FD to the date itself).
- **Immutability.** Business documents (the tables with `status`) can only change from `posted` to `void` (`status`, `voided_at`, `void_reason` together); nothing else changes and a void never goes back. Each has `trg_<table>_business_date_immutable` (`BUSINESS_DATE_IMMUTABLE`), `trg_<table>_posted_at_immutable` (`POSTED_AT_IMMUTABLE`) and a `trg_<table>_immutable` trigger (`<TABLE>_IMMUTABLE`). A correction is a void plus a new record.
- **Append-only ledgers and return tables** reject every UPDATE and DELETE (`trg_<table>_no_update` / `_no_delete`): `audit_logs`, `stock_movements`, `cash_entries`, `icecream_fund_entries`, `purchase_returns`, `purchase_return_items`, `sales_returns`, `sales_return_items`, `icecream_sales`, `import_runs`, `import_issues`.
- **No hard deletes.** Every other business table has a `BEFORE DELETE` trigger that aborts with `RECORD_DELETE_FORBIDDEN` (migration 007 for the older tables; the newer tables carry their own). Not covered on purpose: `stocktake_items` (a draft sheet is rewritten by delete + insert; completed and void sheets are frozen by triggers) and the catalogue tables (`categories`, `suppliers`, `products`: retired with `active = 0`).
- **Idempotency.** Business tables have `client_ref TEXT NOT NULL UNIQUE` (`sales` has `UNIQUE (client_ref, book)`). The browser sends a fresh reference per form submission.
- **Caps.** Amounts in the newer tables are limited to 10^12 cents (`1000000000000`); quantities to 10^6 where noted.
- **Every FK column has an index.**
- **Trigger aborts reach the API only if a service maps them.** Each write service maps the aborts it expects (`FUTURE_DATE_NOT_ALLOWED`, `DAY_CLOSED`, `INVALID_BUSINESS_DATE`, `RETURN_BEFORE_ORIGINAL_DATE`, `STOCK_VALUE_WITHOUT_QTY`, ...) to the API errors in API_CONTRACTS.md. An abort nobody maps (for example `PRODUCT_BOOK_MISMATCH` if a service missed its own check) surfaces as `500 INTERNAL_ERROR`.

## Migrations

| File | Phase | Adds |
|---|---|---|
| `001_foundation.sql` | 1 | `schema_migrations`, `settings`, `audit_logs` |
| `002_audit_append_only.sql` | 1 | triggers that make `audit_logs` append-only |
| `003_catalog.sql` | 2 | `categories` (12 seeded), `suppliers`, `products` + triggers |
| `004_purchases_inventory.sql` | 3 | `stock_movements` (+ cache trigger), `cash_entries`, `purchases`, `purchase_items`, `purchase_returns`, `purchase_return_items`; `audit_logs.business_date`, `audit_logs.backdated` |
| `005_stocktake_losses_drawings.sql` | 4 | `stocktakes`, `stocktake_items`, `stock_losses`, `owner_drawings` |
| `006_sales_returns.sql` | 5 | `sales`, `sale_items`, `sales_returns`, `sales_return_items`; `stock_losses.sales_return_id` |
| `007_no_hard_deletes.sql` | 5 | `BEFORE DELETE` guards on purchases, purchase_items, stocktakes, stock_losses, owner_drawings, sales, sale_items |
| `008_sale_extra_cost.sql` | 5 amendment | extra-cost columns (BUSINESS_RULES C13) |
| `009_telecom.sql` | 6 | `reload_providers` (4 seeded), `reload_sales`, `ezcash_sales`, `telecom_topups` |
| `010_printing.sql` | 7 | `print_service_types` (7 seeded), `print_sales`, `printing_supplies` |
| `011_opening_stock_import.sql` | 13 | `opening_stock_batches`, `import_runs`, `import_issues` |
| `012_cashbooks_expenses.sql` | 8 | `expenses`, `capital_entries`, `cash_counts`, `daily_closings`, `icecream_fund_entries`; `DAY_CLOSED` trigger on `cash_entries`; `INVALID_BUSINESS_DATE` triggers on 14 older tables |
| `013_cash_transfers.sql` | 9 | `cash_transfers`; transfer-leg trigger on `cash_entries`; cash-drawing amount trigger |
| `014_icecream.sql` | 10 | `icecream_days`, `icecream_sales`, `icecream_payments`, `icecream_fund_moves` + day-closed triggers |

Migrations are applied in order, each in its own transaction together with its `schema_migrations` row. The checksum is SHA-256 of the file text with CRLF normalised to LF. A changed applied file stops startup (`MIGRATION_CHECKSUM_MISMATCH`); a database newer than the program stops startup (`MIGRATION_DB_TOO_NEW`). The restore check requires only the Phase 1 tables (`schema_migrations`, `settings`, `audit_logs`); an older backup is upgraded by `migrate()` after the swap.

---

## Table reference

Columns are listed as `name TYPE` with constraints that matter. `id` is `INTEGER PRIMARY KEY AUTOINCREMENT` everywhere except `schema_migrations` and `settings`. Unless stated, every business table also has `business_date`, `posted_at` and the conventions above.

### Bookkeeping and audit

**`schema_migrations`** `version INTEGER PK`, `name`, `checksum`, `applied_at`.

**`settings`** `key TEXT PK CHECK IN ('shop','rates','printDefaults')`, `value_json TEXT CHECK json_valid`, `updated_at`. No seed rows: when a row is missing the service uses its built-in default (below). Adding a key needs a table rebuild because SQLite cannot alter a CHECK.

Defaults applied by `settings.service.ts`:
- `shop`: name `Viman Mobile`, address `162 Padiliyathuduwa Rd, Hunupitiya, Wattala`, phone `+94 71 900 4044`, email `viman.mobile.shop@gmail.com`.
- `rates`: `reloadCommissionBp = 600`, `ezcashCommissionBp = 80`.
- `printDefaults`: the same seven types as `print_service_types` below. **Nothing reads this list at run time** (see "Printing defaults" under `print_service_types`).

**`audit_logs`** `at`, `entity`, `entity_id TEXT`, `action`, `before_json`, `after_json` (NULL or valid JSON), `note`, `business_date TEXT` (NULL for non-financial entries), `backdated INTEGER NOT NULL DEFAULT 0`. Append-only (`audit_logs_no_update`, `audit_logs_no_delete`). Indexes `(entity, entity_id)`, `at`, `business_date`.
Entities and actions written today: `settings` update; `backup` restore; `category`, `product`, `supplier` create/update; `purchase` create/void; `purchase_return` create; `stocktake` create/update/complete/void; `stock_loss` create/void; `drawing` create/void; `sale` create/void; `sale_return` create; `reload_provider` update; `reload_sale`, `ezcash_sale`, `telecom_topup` create/void; `print_service_type` create/update; `print_sale`, `printing_supply` create/void; `opening_stock_batch` create/void; `expense` create/void; `capital_entry` create/void; `cash_count` create/void; `daily_closing` close/reopen; `cash_transfer` create/void; `icecream_day` create/replace/void; `icecream_payment` create/void; `icecream_fund_move` create/void. Manual and start-up backups are not audited.

### Catalogue (not financial: no `client_ref`, no business date)

**`categories`** `name TEXT UNIQUE COLLATE NOCASE`, `book IN ('shop','telecom')`, `is_default`, `active`, `created_at`, `updated_at`. Seeded (all `is_default = 1`): shop — Phone Accessories, Tempered Glass, Phone Covers, Electronics, Stationery, Snacks and Drinks, Party Items, Perfume, Pooja Items, SIM, Other; telecom — Scratch Cards (12 rows). Triggers: `DEFAULT_CATEGORY_LOCKED` (name/book of a default row cannot change), `CATEGORY_HAS_PRODUCTS` (book cannot change while products exist).

**`suppliers`** `name UNIQUE COLLATE NOCASE`, `phone`, `notes`, `active`, timestamps.

**`products`** `code TEXT UNIQUE COLLATE NOCASE NULL`, `name UNIQUE COLLATE NOCASE`, `description`, `category_id FK`, `kind IN ('stock','service')`, `book IN ('shop','telecom')`, `sell_price_cents`, `min_price_cents`, `reorder_level`, `active`, `qty_on_hand`, `stock_value_cents` (the stock cache), timestamps. CHECKs: `qty_on_hand >= 0 AND stock_value_cents >= 0`; a service holds no stock; `0 <= min_price <= sell_price`; `reorder_level >= 0`; non-empty name; `code` NULL or non-empty. Triggers: `PRODUCT_BOOK_MISMATCH` (book must equal the category's book, on insert and on category/book update), `PRODUCT_KIND_IMMUTABLE` (kind and book never change), `STOCK_VALUE_WITHOUT_QTY` (quantity 0 with value left is refused). The cache columns are written only by `trg_stock_movements_cache`.

### Inventory and purchases

**`stock_movements`** (append-only) `product_id FK`, `business_date`, `posted_at`, `type IN ('opening','purchase','purchase_return','purchase_void','sale','sale_return','sale_void','personal_use','loss','stocktake_gain','stocktake_loss','adjustment')`, `qty_delta`, `value_delta_cents`, `unit_cost_cents NULL`, `ref_table NULL`, `ref_id NULL`, `reason`. `CHECK (qty_delta <> 0 OR value_delta_cents <> 0)`. `trg_stock_movements_cache` (AFTER INSERT) adds the deltas to `products.qty_on_hand` / `stock_value_cents`, so the cache can only change through a movement. Indexes `(product_id, posted_at)`, `business_date`, `(ref_table, ref_id)`. Invariant (tested, checked by `GET /inventory/reconciliation`): per product, Σ movements = cache.
`ref_table` values written: `purchases`, `purchase_returns`, `stocktakes`, `stock_losses`, `owner_drawings`, `sales`, `sales_returns`, `opening_stock_batches`. Movement types written: `purchase`, `purchase_return`, `purchase_void`, `sale`, `sale_return`, `personal_use`, `loss`, `stocktake_gain`, `stocktake_loss`, `opening`, `adjustment` (value-only residual sweep, R4). A void writes exact negations with the **same type** as the original (BUSINESS_RULES C6); `sale_void` is allowed by the CHECK but the sale void path reuses `sale`.

**`purchases`** `business_date`, `posted_at`, `supplier_id FK NULL`, `bill_no TEXT DEFAULT ''`, `book IN ('shop','telecom')`, `total_cents >= 0`, `status`, `client_ref UNIQUE`, `notes`, `voided_at`, `void_reason`. Triggers: R-FD, `PURCHASE_IMMUTABLE`, date/posted-at immutability, no delete.

**`purchase_items`** `purchase_id FK`, `product_id FK`, `packs >= 1`, `pack_size >= 1`, `units`, `line_total_cents >= 0`, `returned_units DEFAULT 0`. `CHECK (units = packs * pack_size)`, `CHECK (returned_units BETWEEN 0 AND units)`. `PURCHASE_ITEM_IMMUTABLE`: only `returned_units` may change, never downwards. No delete.

**`purchase_returns`** (append-only) `purchase_id FK`, `business_date`, `posted_at`, `refund_cents >= 0`, `note`, `client_ref UNIQUE`. Triggers: R-FD; `RETURN_BEFORE_ORIGINAL_DATE` (R-RD: return date earlier than the purchase's date); `PURCHASE_VOID` (no return against a void purchase).

**`purchase_return_items`** (append-only) `purchase_return_id FK`, `purchase_item_id FK`, `units >= 1`, `value_cents >= 0`. `RETURN_ITEM_MISMATCH`: the line must belong to the same purchase as the return.

### Stocktake, losses, drawings

**`stocktakes`** `business_date`, `posted_at`, `book IN ('shop','telecom')`, `status IN ('draft','completed','void') DEFAULT 'draft'`, `notes`, `client_ref UNIQUE`, `completed_at`, `voided_at`, `void_reason`. CHECKs: void needs `voided_at` and `void_reason`; completed needs `completed_at`. `STOCKTAKE_TRANSITION`: only draft→completed, draft→void, completed→void; `notes` change only while draft.

**`stocktake_items`** `stocktake_id FK`, `product_id FK`, `counted_qty >= 0`, `expected_qty NULL`, `difference_qty NULL`, `value_delta_cents NULL`, `gain_unit_cost_cents NULL >= 0`, `UNIQUE (stocktake_id, product_id)`. Triggers: `STOCKTAKE_NOT_DRAFT` (insert, delete and update only while the parent is a draft), `PRODUCT_NOT_IN_BOOK` (stock product of the stocktake's book).

**`stock_losses`** `business_date`, `posted_at`, `product_id FK`, `book IN ('shop','telecom')`, `qty >= 1`, `cost_cents >= 0`, `reason IN ('damaged','lost','expired','other')`, `note`, `source IN ('manual','damaged_return') DEFAULT 'manual'`, `status`, `client_ref UNIQUE`, `voided_at`, `void_reason`, `sales_return_id FK NULL` (added by 006). Triggers: `STOCK_LOSS_IMMUTABLE`; `DAMAGED_RETURN_LINK` (`source = 'damaged_return'` iff `sales_return_id` set), `DAMAGED_RETURN_DATE` (same business date as the return), `DAMAGED_RETURN_REASON` (reason `damaged`); `sales_return_id` frozen after insert.

**`owner_drawings`** `business_date`, `posted_at`, `book IN ('shop','telecom','icecream')`, `fund NULL`, `kind IN ('cash','goods')`, `amount_cents >= 0`, `product_id FK NULL`, `qty NULL`, `note`, `status`, `client_ref UNIQUE`, `voided_at`, `void_reason`. CHECKs: `(book = 'icecream') = (fund IS NOT NULL)`; no goods drawing in the Ice Cream book; goods needs a product and `qty >= 1`; cash has neither. `OWNER_DRAWING_IMMUTABLE`; `CASH_DRAWING_AMOUNT` (013): a cash drawing must be 1..10^12 cents (a goods drawing of 0 is allowed).

### Sales

**`sales`** `business_date`, `posted_at`, `book IN ('shop','telecom')`, `total_cents >= 0`, `status`, `notes`, `client_ref`, `voided_at`, `void_reason`, `UNIQUE (client_ref, book)`. `SALE_IMMUTABLE`.

**`sale_items`** `sale_id FK`, `line_no >= 1`, `line_type IN ('goods','card')`, `product_id FK`, `description`, `qty >= 1`, `unit_price_cents >= 0`, `unit_cost_cents >= 0` (automatic unit cost, display snapshot), `revenue_cents`, `cogs_cents` (stock value removed, frozen), `returned_qty DEFAULT 0`, `extra_cost_cents NOT NULL DEFAULT 0 CHECK (>= 0)` (008). `UNIQUE (sale_id, line_no)`, `CHECK (revenue_cents = qty * unit_price_cents)`, `CHECK (returned_qty BETWEEN 0 AND qty)`. `SALE_ITEM_IMMUTABLE` (only `returned_qty`, upwards), `SALE_ITEM_BOOK_MISMATCH` (goods ⇔ shop sale, card ⇔ telecom sale, product book = sale book). Print and other services are **not** sale lines: printing has its own table.

**`sales_returns`** (append-only) `sale_id FK`, `business_date`, `posted_at`, `refund_cents`, `cogs_reversed_cents`, `extra_cost_reversed_cents NOT NULL DEFAULT 0` (008), `note`, `client_ref UNIQUE`. Triggers: R-FD, `RETURN_BEFORE_ORIGINAL_DATE`, `SALE_VOID`.

**`sales_return_items`** (append-only) `sales_return_id FK`, `sale_item_id FK`, `qty >= 1`, `resalable IN (0,1)`, `revenue_cents`, `cogs_cents`, `extra_cost_cents NOT NULL DEFAULT 0` (008). Triggers: `RETURN_ITEM_MISMATCH`, `RETURN_EXCEEDS_SOLD` (qty ≤ sold − returned at insert time), `RETURN_EXCEEDS_EXTRA_COST` (cumulative reversed extra ≤ the line's extra).

### Telecom

**`reload_providers`** `name TEXT UNIQUE NOT NULL`, `commission_bp NULL CHECK (NULL or 0..10000)` (NULL = use `settings.rates.reloadCommissionBp`), `active`, `sort_order`. Seeded: Dialog (1), Mobitel (2), Hutch (3), Airtel (4), all with `commission_bp` NULL. Triggers: `PROVIDER_NAME_IMMUTABLE`, no delete. Editable: rate and active.

**`reload_sales`** `business_date`, `posted_at`, `provider_id FK`, `sales_cents` (1..10^12), `commission_bp` (0..10000, snapshot), `extra_cents` (0..10^12, default 0), `commission_cents >= 0`, `status`, `voided_at`, `void_reason`, `notes`, `client_ref UNIQUE`. `COMMISSION_MISMATCH` (before insert): `commission_cents` must equal `(sales_cents * commission_bp + 5000) / 10000 + extra_cents` in integer arithmetic (half-up, the same as half away from zero for non-negative numbers). Indexes `business_date`, `(provider_id, business_date)`.

**`ezcash_sales`** `business_date`, `posted_at`, `provider_id FK`, `bill_total_cents` (1..10^12), `commission_bp`, `commission_cents`, status columns, `notes`, `client_ref UNIQUE`. `EZCASH_PROVIDER_NOT_DIALOG` (provider must be the one named `Dialog`), `COMMISSION_MISMATCH` (same formula without extra).

**`telecom_topups`** `business_date`, `posted_at`, `kind IN ('provider_topup','wallet_topup')`, `provider_id FK NULL`, `amount_cents` (1..10^12), status columns, `notes`, `client_ref UNIQUE`. CHECK: provider top-up needs a provider; wallet top-up has none.

### Printing

**`print_service_types`** `code TEXT UNIQUE` (2–20 chars, `A-Z 0-9 _`), `name`, `price_cents` (0..10^9), `cost_cents` (0..10^9), `active`, `sort_order`. Seeded (code, name, price, standard cost, in cents):

| Code | Name | Price | Cost |
|---|---|---|---|
| `BW_1S` | B/W print – one side | 1500 | 650 |
| `BW_2S` | B/W print – double side | 2500 | 900 |
| `CLR_1S` | Colour print – one side | 2000 | 650 |
| `CLR_2S` | Colour print – double side | 3000 | 900 |
| `PC_BW_1S` | Photocopy B/W – one side | 1000 | 650 |
| `PC_BW_2S` | Photocopy B/W – double side | 1500 | 900 |
| `CUSTOM` | Custom image print | 4000 | 650 |

Triggers: `PRINT_TYPE_CODE_IMMUTABLE`, no delete. Editable: name, price, cost, active.
*Printing defaults:* this table is the operational source of truth. It is seeded once by the migration. The Settings → Printing defaults tab edits `settings.printDefaults`, which no service reads, so changing it does not change any print service type or price.

**`print_sales`** `business_date`, `posted_at`, `service_type_id FK`, `description` (snapshot of the type name), `qty` (1..10^6), `unit_price_cents` (0..10^9), `unit_cost_cents` (0..10^9, snapshot of the type's standard cost), `revenue_cents`, `cogs_cents`, status columns, `notes`, `client_ref UNIQUE`. `CHECK (revenue_cents = qty * unit_price_cents AND cogs_cents = qty * unit_cost_cents)`. `SERVICE_TYPE_INACTIVE` trigger refuses a sale on an inactive type.

**`printing_supplies`** `business_date`, `posted_at`, `amount_cents` (1..10^12), `description`, status columns, `client_ref UNIQUE`. (No `notes` column.)

### Opening stock

**`opening_stock_batches`** `business_date`, `posted_at`, `source IN ('manual','excel')`, `file_name NULL` (required iff excel), `row_count >= 0`, `total_value_cents >= 0`, `status`, `voided_at`, `void_reason`, `notes`, `client_ref UNIQUE`. There is no lines table: the lines of a batch are its `opening` stock movements (`ref_table = 'opening_stock_batches'`, `ref_id` = batch id). No cash entry, no purchase, no P&L.

**`import_runs`** (append-only) `kind = 'opening_stock'`, `file_name`, `file_sha256` (64 chars), `business_date`, `mode IN ('preview','commit')`, `status IN ('previewed','committed','rejected')`, `rows_total`, `rows_ok`, `rows_failed` (`ok + failed = total`), `batch_id FK NULL`, `created_at`. CHECK ties mode, status and `batch_id` together (a committed run has a batch and no failed rows).

**`import_issues`** (append-only) `import_run_id FK`, `row_no`, `column_name`, `code`, `message`.

### Cash ledger and cash books

**`cash_entries`** (append-only) `book`, `business_date`, `posted_at`, `type`, `amount_cents` (signed: in +, out −), `fund NULL`, `ref_table NULL`, `ref_id NULL`, `transfer_id NULL`, `reverses_entry_id FK NULL`, `note NULL`. Balance of a book = Σ `amount_cents`. `type` is one of 24 values (BUSINESS_RULES §2): `sale_goods`, `sale_service`, `sale_refund`, `card_sale`, `card_refund`, `reload_collection`, `ezcash_collection`, `provider_topup`, `wallet_topup`, `purchase_payment`, `purchase_refund`, `expense`, `expense_refund`, `icecream_sale`, `icecream_materials_payment`, `icecream_electricity_payment`, `icecream_other_cost`, `printing_supplies`, `cash_adjustment`, `opening_balance`, `capital`, `drawing_cash`, `transfer_out`, `transfer_in`.
CHECKs: `(book = 'icecream') = (fund IS NOT NULL)`; `type NOT LIKE 'icecream_%' OR book = 'icecream'`; purchase payment/refund only in shop or telecom.
Triggers: R-FD; `INVALID_BUSINESS_DATE`; `DAY_CLOSED` (insert refused when a closed `daily_closings` row exists for that book and date); `TRANSFER_LEG_MISMATCH` (013: `transfer_out`/`transfer_in` must carry an existing `transfer_id` and sit in the right book and fund; no other type may carry a `transfer_id`).
A reversal is a new row with negated amount, the same type, `reverses_entry_id` set and the original's business date. Written today: all types above except `sale_service` is written by printing sales, `printing_supplies` by supplies, and `expense_refund` is **never written** (an expense void reverses the `expense` entry instead). `cash_adjustment` is written by cash counts and daily closings.

**`expenses`** `business_date`, `posted_at`, `book IN ('shop','telecom')`, `category IN ('water','rent','internet','transport','repairs','cleaning_supplies','packaging','stationery','other')`, `amount_cents` (1..10^12), `description`, `notes`, status columns, `client_ref UNIQUE`. No `electricity` value can be stored (BUSINESS_RULES E2).

**`capital_entries`** `business_date`, `posted_at`, `book`, `fund NULL`, `kind IN ('opening_balance','capital')`, `amount_cents` (1..10^12), `note`, status columns, `client_ref UNIQUE`. `CHECK ((book = 'icecream') = (fund IS NOT NULL))`. Unique index `ux_capital_opening_balance` on `(book, COALESCE(fund,''))` where `kind = 'opening_balance' AND status = 'posted'`: at most one posted opening balance per book (per fund for Ice Cream); a wrong one is voided and entered again.

**`cash_counts`** `book`, `fund NULL`, `business_date`, `posted_at`, `expected_cents`, `counted_cents` (0..10^12), `difference_cents` (CHECK = counted − expected), `note`, status columns, `cash_entry_id FK NULL`, `client_ref UNIQUE`. CHECKs: a non-zero difference needs a non-empty note; `fund` is set iff the book is `icecream` and the difference is not zero. `expected_cents` is the ledger balance of the book as of the end of the business date.

**`daily_closings`** `book`, `business_date`, `posted_at`, `closed_at`, `reopened_at NULL`, `reopen_reason NULL`, `expected_cents`, `counted_cents NULL`, `over_short_cents DEFAULT 0`, `cash_count_id FK NULL`, `UNIQUE (book, business_date)`. A day is **closed** iff `reopened_at IS NULL OR closed_at > reopened_at`. `DAILY_CLOSING_IMMUTABLE` allows only a reopen (set `reopened_at`, reason of at least 3 characters) or a re-close (new `closed_at` later than `reopened_at`, with the figures). No delete. (No `client_ref`, no status.)

### Cash transfers

**`cash_transfers`** `business_date`, `posted_at`, `from_book`, `to_book`, `from_fund NULL`, `to_fund NULL`, `amount_cents` (1..10^12), `note`, status columns, `client_ref UNIQUE`. CHECKs: `from_book <> to_book`; `from_fund` set iff `from_book = 'icecream'`; `to_fund` set iff `to_book = 'icecream'`. Cash: `transfer_out` (−) in the from book and `transfer_in` (+) in the to book, both with `cash_entries.transfer_id` = the transfer id. A void adds the opposite pair (4 rows, net zero).

### Ice Cream

**`icecream_days`** `business_date`, `posted_at`, `sales_cents`, `cost_alloc_cents`, `electricity_alloc_cents` (each 0..10^12), `profit_share_cents` (server-computed), `negative_confirmed`, `notes`, status columns, `client_ref UNIQUE`. CHECKs: `cost_alloc + electricity_alloc + profit_share = sales`; `profit_share >= 0 OR negative_confirmed = 1`. Unique index `ux_icecream_days_posted` on `business_date` where `status = 'posted'` (one posted entry per date; a replacement voids the old row first). Triggers: `DAY_CLOSED` on insert and on void.

**`icecream_sales`** (append-only) optional item lines of a day: `icecream_day_id FK`, `item_name`, `qty` (1..10^6), `unit_price_cents`, `line_total_cents` (CHECK = qty × price). The service requires the lines to sum to `sales_cents`.

**`icecream_payments`** `business_date`, `posted_at`, `kind IN ('materials','electricity_bill','other_cost')`, `fund`, `amount_cents` (1..10^12), `category NULL`, `description`, status columns, `client_ref UNIQUE`. `CHECK (category IS NULL OR lower(trim(category)) <> 'electricity')` (BUSINESS_RULES E4). `DAY_CLOSED` trigger on insert. Cash types: `materials` → `icecream_materials_payment`, `electricity_bill` → `icecream_electricity_payment`, `other_cost` → `icecream_other_cost`.

**`icecream_fund_moves`** `business_date`, `posted_at`, `from_fund`, `to_fund` (`from <> to`), `amount_cents` (1..10^12), `profit_effect_cents`, `charge_relabel_cents DEFAULT 0`, `cash_only_cents DEFAULT 0`, `note`, status columns, `client_ref UNIQUE`. A three-way CHECK fixes the sign rules: into Profit (release) `profit_effect + cash_only = amount`, `relabel = 0`; out of Profit (re-allocation) `profit_effect = −amount`; Cost ↔ Electricity `profit_effect = 0`, `cash_only = 0`, `0 <= relabel <= amount`. `DAY_CLOSED` triggers on insert and on void (a fund move writes no cash entry, so the `cash_entries` trigger alone would not protect it).

**`icecream_fund_entries`** (append-only fund ledger) `business_date`, `posted_at`, `fund`, `amount_cents <> 0` (signed), `kind IN ('daily_allocation','payment','fund_move','drawing','transfer_out','transfer_in','opening_balance','capital','cash_over_short','reversal')`, `ref_table`, `ref_id`, `reverses_entry_id FK NULL` (`kind = 'reversal'` iff set), `note`. Fund balance = Σ per fund. Invariant (tested; reported by `GET /cashbooks` as `ICECREAM_FUNDS_MISMATCH` if broken): Σ fund entries of all funds = Σ `cash_entries` of the `icecream` book. Only fund moves write a fund entry without a cash entry. A daily entry writes one `icecream_sale` cash entry plus one matching `daily_allocation` fund entry per non-zero fund share.

Not stored: Charged/Settled/Unspent per line, profit-eligible limits, D4 splits, the D2 guard and excess cost. They are derived from posted rows in posting order (`posted_at`, then `id`) every time (BUSINESS_RULES §10.4).

---

## Cross-table rules and invariants

| Rule | Enforced by |
|---|---|
| Stock cache = Σ movements (per product) | `trg_stock_movements_cache` is the only writer; reconciliation endpoint and tests |
| Cash book balance = Σ `cash_entries` | no stored balance |
| Σ fund entries = Σ Ice Cream cash entries; Cost + Electricity + Profit = Ice Cream cash book | service writes both rows in one transaction; tested invariant |
| No electricity expense in any segment | `expenses.category` CHECK, API `ELECTRICITY_NOT_ALLOWED`, `icecream_payments.category` CHECK |
| No future dates | service + R-FD triggers |
| Return not before the original | service + `RETURN_BEFORE_ORIGINAL_DATE` triggers on `sales_returns`, `purchase_returns` |
| No return on a void document, no void of a document with returns | triggers `SALE_VOID`, `PURCHASE_VOID`; service `HAS_RETURNS` |
| Closed days refuse cash entries and Ice Cream records | service `assertDayOpen` + `DAY_CLOSED` triggers |
| Reversals copy the business date of the original | services (`reverseCash`, `reverseMovements`) |
| Ledgers never edited or deleted | append-only triggers |
