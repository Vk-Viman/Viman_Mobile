# Database migrations - what each file builds and why

The database structure is created by the numbered `.sql` files in this folder. The runner
(`../migrate.ts`) applies the ones a database has not seen yet, in order, each inside one transaction, and
stores a checksum (SHA-256 of the file text, line endings normalised) of every applied file.

**Never edit a migration that has already been applied.** The real shop database was built from the exact
text, so changing even a comment changes the checksum and the system refuses to start
(`MIGRATION_CHECKSUM_MISMATCH`). To change the structure, add a new file with the next number. That is also
why the explanations below live in this README and not inside the released `.sql` files.

Two ideas appear in almost every migration:

- **The database is the backstop.** The services (TypeScript) check every rule first and give friendly
  messages, but the same rules are repeated here as `CHECK` constraints and triggers, so that even a bug in
  the program cannot store a wrong figure. A trigger that refuses a change uses `RAISE(ABORT, '<CODE>')`; the
  service layer recognises the code and answers with the matching API error.
- **Ledgers are append-only.** Money and stock history is never edited or deleted (BUSINESS_RULES R1,
  section 12). A mistake is corrected by a new reversing row. Triggers named `*_no_update` / `*_no_delete`
  enforce this.

Dates: the shop's calendar date is `date('now','+330 minutes')` (Colombo is UTC+5:30 all year, no daylight
saving). Business dates are stored as text `YYYY-MM-DD`; timestamps as ISO-8601 UTC text.

---

## 001_foundation.sql - bookkeeping, settings, audit log (Phase 1)

| Table | Purpose |
|---|---|
| `schema_migrations` | Which migration files were applied and their checksum (used by the runner above). |
| `settings` | Shop details, commission rates and print price defaults, one JSON document per section. |
| `audit_logs` | "Who changed what": a before/after JSON snapshot of every edit, void, restore and settings change. |

- `settings.key` is restricted by a `CHECK` to `shop`, `rates` and `printDefaults`; `value_json` must be valid
  JSON (`json_valid`). This stops a typo from creating a stray settings section.
- `audit_logs.before_json` / `after_json` must be NULL or valid JSON. The `CHECK (x IS NULL OR json_valid(x))`
  form is deliberate: in SQL a CHECK that evaluates to NULL counts as *passing*, so NULL is allowed on purpose
  and anything else must be valid JSON.
- Indexes on `(entity, entity_id)` and on `at` make "show the history of this record" and "newest first" fast.

## 002_audit_append_only.sql - the audit log cannot be edited (Phase 1)

- Triggers `audit_logs_no_update` and `audit_logs_no_delete` abort any `UPDATE` / `DELETE` of an audit row.
  The application never edits the audit trail (rule R1, section 12); these triggers make the database itself
  refuse it too, so even a bug or a hand-typed SQL command cannot rewrite history.

## 003_catalog.sql - categories, suppliers, products (Phase 2)

| Table | Purpose |
|---|---|
| `categories` | Product groups. Each category belongs to one book (`shop` or `telecom`, section 1). Twelve default categories are inserted (incl. *Scratch Cards* in the telecom book). |
| `suppliers` | People/companies the shop buys from. |
| `products` | Everything the shop sells: `kind` is `stock` (counted) or `service` (printing etc., never counted). |

Names and codes are `COLLATE NOCASE UNIQUE`, so "Pen" and "pen" count as the same product. Rows are never
deleted; `active = 0` hides a record (no hard deletes of anything that history may refer to, section 12).

`products` carries the **stock cache** (`qty_on_hand`, `stock_value_cents`, section 3). The CHECKs on the table
enforce: quantity and value are never negative; a *service* always has 0 quantity and 0 value; the minimum
price is not above the selling price; all prices and the reorder level are zero or more.

Triggers (error code in brackets):

- `trg_categories_default_locked` (`DEFAULT_CATEGORY_LOCKED`): the name and book of a built-in category cannot
  change, so reports that rely on e.g. *Scratch Cards* being telecom stay correct.
- `trg_categories_book_has_products` (`CATEGORY_HAS_PRODUCTS`): a category that already has products cannot
  switch book (the products would then sit in the wrong cash book).
- `trg_products_book_insert` / `trg_products_book_update` (`PRODUCT_BOOK_MISMATCH`): a product's book must
  equal its category's book. `IS NOT` is used rather than `<>` so that a missing category (NULL) also fails.
- `trg_products_kind_immutable` (`PRODUCT_KIND_IMMUTABLE`): a product can never change between stock and
  service, or move between books, after creation - its history would stop making sense.

## 004_purchases_inventory.sql - stock ledger, cash ledger, purchases (Phase 3)

| Table | Purpose |
|---|---|
| `stock_movements` | Append-only inventory ledger: one row per quantity/value change of a product. |
| `cash_entries` | Append-only cash ledger for the three cash books (`shop`, `telecom`, `icecream`); amounts are signed (in +, out -). |
| `purchases`, `purchase_items` | A supplier bill and its lines (packs x pack size = units; the exact line total is kept, so no per-unit rounding loss). |
| `purchase_returns`, `purchase_return_items` | Goods sent back to the supplier (append-only). |
| `audit_logs` (altered) | Gains `business_date` and `backdated` columns (section 12). |

Stock movements and the cache:

- `stock_movements.type` is restricted to the movement types of section 3 (`opening`, `purchase`,
  `purchase_return`, `purchase_void`, `sale`, `sale_return`, `sale_void`, `personal_use`, `loss`,
  `stocktake_gain`, `stocktake_loss`, `adjustment`). A movement must change quantity or value (never both zero).
- `trg_stock_movements_cache` (AFTER INSERT) adds the movement to `products.qty_on_hand` / `stock_value_cents`.
  The cache is therefore maintained **only by the database**, so "sum of movements = cache" cannot drift.
  Only those two columns are updated, so the Phase 2 triggers on kind/book/category do not fire.
- `trg_products_value_without_qty` (`STOCK_VALUE_WITHOUT_QTY`): a product may not reach quantity 0 while still
  holding value. This is the backstop for rule R4: the service must first "sweep" the leftover value with a
  value-only `adjustment` movement. Until then the database refuses the state.
- The products CHECKs (qty >= 0, value >= 0) abort any movement that would oversell: this is the final guard
  behind the friendly "Only 3 in stock" message.
- `trg_stock_movements_no_update` / `_no_delete`: append-only.

Cash ledger CHECKs:

- `(book = 'icecream') = (fund IS NOT NULL)`: an ice-cream entry must name exactly one fund
  (cost/electricity/profit, section 10.2) and shop/telecom entries must name none. Written as a comparison of
  two true/false values so a NULL fund cannot slip through a NULL-passes-CHECK gap.
- `type NOT LIKE 'icecream_%' OR book = 'icecream'`: ice-cream entry types only in the ice-cream book.
- Purchase payments/refunds only in the shop or telecom book (section 7: purchases are paid from the book
  derived from their products).
- `reverses_entry_id` links a reversal row to the entry it cancels (rule R1: voids add rows, never edit).
- `trg_cash_entries_no_update` / `_no_delete`: append-only.

Dates (rule R-FD, R-RD):

- Every table with a business date has a `CHECK` that the text is a real calendar date
  (`GLOB` for the shape and `date(x) = x` to reject 31 February).
- `trg_*_future_date` (`FUTURE_DATE_NOT_ALLOWED`): a business date after today (Colombo) is refused on insert.
- `trg_purchase_returns_before_original` (`RETURN_BEFORE_ORIGINAL_DATE`, R-RD): a purchase return cannot be
  dated before the purchase it returns.

Purchases:

- `client_ref` is `UNIQUE`: the browser sends a fresh reference per form submission, so a double click or a
  retry can never create the same purchase twice (idempotency).
- `trg_purchases_business_date_immutable` (`BUSINESS_DATE_IMMUTABLE`) and `trg_purchases_posted_at_immutable`
  (`POSTED_AT_IMMUTABLE`): the business date and the server posting time can never be edited after posting;
  a correction is a void-and-replace.
- `trg_purchases_immutable` (`PURCHASE_IMMUTABLE`): the only allowed change is `posted -> void` (setting
  `status`, `voided_at`, `void_reason` together); nothing else changes and a void never goes back.
- `purchase_items`: `CHECK (units = packs * pack_size)`, `returned_units` between 0 and `units`;
  `trg_purchase_items_immutable` allows only `returned_units` to grow.
- `trg_purchase_returns_void` (`PURCHASE_VOID`): no return against a voided purchase.
- `trg_purchase_return_items_mismatch` (`RETURN_ITEM_MISMATCH`): a return line must belong to the same
  purchase as its return header.
- Returns and their lines are append-only (`*_no_update`, `*_no_delete`).

`audit_logs` gets `business_date` and `backdated` so that backdated corrections can be listed
(section 12). The append-only triggers from 002 are untouched.

## 005_stocktake_losses_drawings.sql - counts, write-offs, owner drawings (Phase 4)

No stock or cash ledger changes: the movements for these records are written by the inventory engine
(`services/inventory.service.ts`) using the Phase 3 tables.

| Table | Purpose |
|---|---|
| `stocktakes`, `stocktake_items` | A physical count of a book. Starts as `draft` (editable), then `completed` (differences posted as movements) or `void`. |
| `stock_losses` | Damaged / lost / expired / other stock removed at average cost (R2, R3; section 11). |
| `owner_drawings` | The owner taking goods (`kind = 'goods'`, at cost, no P&L) or cash (`kind = 'cash'`, later phases). |

Common pattern for `stocktakes`, `stock_losses` and `owner_drawings`: unique `client_ref`; future-date trigger
(R-FD); immutable business date and posting time; a transition/immutability trigger so that only the allowed
status change can happen (`STOCKTAKE_TRANSITION`, `STOCK_LOSS_IMMUTABLE`, `OWNER_DRAWING_IMMUTABLE`); a
`status = 'posted' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)` CHECK so a void always records when
and why.

Specific rules:

- `stocktakes`: `draft -> completed | void` and `completed -> void` only. `notes` can change only while a
  draft. `completed_at` never changes once set; void data never changes once void.
- `stocktake_items`: rows can be added, removed or changed only while the parent stocktake is a draft
  (`STOCKTAKE_NOT_DRAFT`); `UNIQUE (stocktake_id, product_id)` means each product is counted once;
  `trg_stocktake_items_product_*` (`PRODUCT_NOT_IN_BOOK`) allow only *stock* products of the stocktake's book.
- `stock_losses`: `qty >= 1`, `cost_cents >= 0`, `reason` in (damaged, lost, expired, other), `source` in
  (manual, damaged_return). The cost is the weighted-average value removed (section 3) and is frozen on the row.
- `owner_drawings`: `(book = 'icecream') = (fund IS NOT NULL)` (same fund rule as the cash ledger); goods
  drawings need a product and a quantity of at least 1 and are never ice-cream; cash drawings must have neither.


## 006_sales_returns.sql - sales, sales returns, damaged-return write-offs (Phase 5)

No stock or cash ledger changes: the movements (`sale`, `sale_return`) and cash entries (`sale_goods`,
`card_sale`, `sale_refund`, `card_refund`) are written by the inventory engine and the sales service.

| Table | Purpose |
|---|---|
| `sales` | One receipt. A mixed cart is split by book, so one cart can make a shop sale and a telecom sale. |
| `sale_items` | The lines: quantity, price, and the cost removed at the weighted average (frozen, C5). |
| `sales_returns`, `sales_return_items` | Goods a customer brings back: refund, cost reversed, resalable or damaged. Append-only. |
| `stock_losses.sales_return_id` | Links the write-off of a damaged returned item to its return. |

Sales:

- `UNIQUE (client_ref, book)`: a repeated submission cannot create the same sale twice, yet one cart may create
  one sale in each book with the same reference.
- Date rules as in earlier phases: strict date CHECK, `FUTURE_DATE_NOT_ALLOWED` (R-FD),
  `BUSINESS_DATE_IMMUTABLE`, `POSTED_AT_IMMUTABLE`.
- `trg_sales_immutable` (`SALE_IMMUTABLE`): only `posted -> void` (status, voided_at, void_reason together); a void
  never goes back (R1).
- `sale_items`: `CHECK (revenue_cents = qty * unit_price_cents)` (no rounding on a line), `returned_qty` between 0
  and `qty`, `UNIQUE (sale_id, line_no)`. `trg_sale_items_immutable` (`SALE_ITEM_IMMUTABLE`) lets only
  `returned_qty` change, and only upwards. `trg_sale_items_book_mismatch` (`SALE_ITEM_BOOK_MISMATCH`): goods
  lines only in shop sales, card lines only in telecom sales, and the product must belong to the sale's book.

Returns:

- `trg_sales_returns_before_original` (`RETURN_BEFORE_ORIGINAL_DATE`, R-RD): same day or later is fine, earlier is not.
- `trg_sales_returns_void` (`SALE_VOID`): no return against a voided sale.
- `trg_sales_return_items_mismatch` (`RETURN_ITEM_MISMATCH`): a line must belong to the return's own sale.
- `trg_sales_return_items_exceeds` (`RETURN_EXCEEDS_SOLD`): the returned quantity must be at most
  `sale_items.qty - sale_items.returned_qty` at insert time. The service inserts the return lines first and
  only then raises `returned_qty` (`addReturnedQty`), so the check sees the quantity still returnable.
- Both return tables are append-only (`*_no_update`, `*_no_delete`).

Damaged returns (`stock_losses`):

- `ALTER TABLE ... ADD COLUMN sales_return_id` (nullable FK, indexed). Phase 4's `STOCK_LOSS_IMMUTABLE` is untouched;
  a small extra trigger freezes the new column too.
- `DAMAGED_RETURN_LINK`: `source = 'damaged_return'` if and only if `sales_return_id` is set.
- `DAMAGED_RETURN_DATE`: the loss carries the return's business date. `DAMAGED_RETURN_REASON`: its reason is 'damaged'.


## 007_no_hard_deletes.sql

**Why:** BUSINESS_RULES section 12 says completed transactions are never hard-deleted; mistakes are fixed by voiding (status `void` + reversal rows). Until this migration only the ledgers and the return tables refused DELETE in the database; the other business documents relied on the application. 

**What it adds:** one `BEFORE DELETE` trigger per table that aborts with `RECORD_DELETE_FORBIDDEN` — `purchases`, `purchase_items`, `stocktakes`, `stock_losses`, `owner_drawings`, `sales`, `sale_items`. 

**Not covered on purpose:** `stocktake_items` (a draft count sheet is rewritten by delete + insert; completed/void sheets are already frozen by migration 005) and the catalogue tables (master data, retired with `active = 0`).


## 008_sale_extra_cost.sql - extra cost on sales (Phase 5 amendment, BUSINESS_RULES C13)

**Why:** when a sale is recorded the cost fills in automatically (weighted average), but the cashier may raise it per unit, never lower it. The part above the automatic cost is the line's **extra cost**. It counts as cost whenever cost is calculated (profit = revenue - automatic cost - extra cost), but it never touches stock, stock movements or cash.

**What it adds (additive `ALTER TABLE ... ADD COLUMN`, existing rows get 0):**

| Column | Purpose |
|---|---|
| `sale_items.extra_cost_cents` | Cost charged above the automatic cost (`cogs_cents`) for the line. `NOT NULL DEFAULT 0 CHECK (>= 0)`. |
| `sales_return_items.extra_cost_cents` | The share of that extra reversed by one returned line (same exact-remainder split as revenue, C5). |
| `sales_returns.extra_cost_reversed_cents` | Sum of the extra reversed by the lines of one return. |

**Triggers:**

- `trg_sale_items_extra_cost_immutable` (`SALE_ITEM_IMMUTABLE`): the immutability trigger of migration 006 predates the column, so this one freezes `extra_cost_cents` of a saved line.
- `trg_sales_return_items_extra_exceeds` (`RETURN_EXCEEDS_EXTRA_COST`): backstop - earlier return lines of the same sale line plus the new one may not exceed the line's extra cost.

Return tables stay append-only (migration 006 triggers). SQLite accepts `ADD COLUMN ... NOT NULL DEFAULT 0 CHECK (...)` on existing tables, and checks the CHECK against existing rows only for new writes, which is fine because the default 0 satisfies it.

## 009_telecom.sql (Phase 6)
Tables `reload_providers` (seeded Dialog, Mobitel, Hutch, Airtel; `commission_bp NULL` = shop default), `reload_sales`, `ezcash_sales`, `telecom_topups`. Triggers: R-FD future-date block, immutability except `posted → void`, delete guards, `COMMISSION_MISMATCH` (commission = half-up(sales × bp / 10000) + extra), `EZCASH_PROVIDER_NOT_DIALOG`, top-up kind/provider rule, provider name immutable and undeletable; amount caps of 10^12 cents. Cash rows (book telecom): `reload_collection`, `ezcash_collection`, `provider_topup`, `wallet_topup`; commission is never a cash entry (R14). Note: SQLite runs BEFORE INSERT triggers before CHECKs, so a bad insert may report the trigger message.

## 010_printing.sql (Phase 7)
Tables `print_service_types` (seven seeded types, `sort_order`), `print_sales` (cost snapshot, `revenue = qty × price`, `cogs = qty × cost`), `printing_supplies`. Triggers: R-FD, immutability (`PRINT_TYPE_CODE_IMMUTABLE`, `PRINT_SALE_IMMUTABLE`, `PRINTING_SUPPLY_IMMUTABLE`), delete guards, sale on an inactive type refused. Uses the stricter date CHECK `date(x) IS NOT NULL AND date(x) = x`. Cash (book shop): `sale_service` +revenue, `printing_supplies` −amount (no P&L, R12).

## 011_opening_stock_import.sql (Phase 13)
Tables `opening_stock_batches`, `import_runs`, `import_issues` (append-only). A batch's lines are its `opening` stock movements (`ref_table = 'opening_stock_batches'`); no separate lines table. No cash, purchase or P&L effect. R-FD trigger on batches only.

**Date-check gap (found by the Phase 7 agent, closed by migration 012):** the date CHECK in migrations 003–006 and 009 (`GLOB … AND date(x) = x`) passes an impossible month such as `2020-13-01` because `date()` returns NULL and a NULL CHECK counts as passed. The API always blocked such dates; migration 012 adds the `INVALID_BUSINESS_DATE` insert triggers described below. Migrations 010 and later use the stricter CHECK (`date(x) IS NOT NULL AND date(x) = x`) directly.

## 012_cashbooks_expenses.sql (Phase 8)
Tables `expenses` (shop/telecom only; no electricity category, E2), `capital_entries` (opening balances now, capital in Phase 9; one posted opening per book+fund), `cash_counts` (difference = counted − expected; note required when non-zero; fund iff Ice Cream and difference ≠ 0), `daily_closings` (closed iff `reopened_at IS NULL OR closed_at > reopened_at`; `DAILY_CLOSING_IMMUTABLE` allows only reopen/re-close), `icecream_fund_entries` (append-only fund ledger; `amount <> 0`; reversal kind ⇔ `reverses_entry_id`). Trigger `trg_cash_entries_day_closed` aborts `DAY_CLOSED` for a cash entry on a closed (book, date). `INVALID_BUSINESS_DATE` triggers (only for well-shaped dates such as `2020-13-01`) on 14 older tables: stock_movements, cash_entries, purchases, purchase_returns, stocktakes, stock_losses, owner_drawings, sales, sales_returns, reload_sales, ezcash_sales, telecom_topups, opening_stock_batches, import_runs — closes the NULL-in-CHECK gap found in Phase 7. `cash_counts.cash_entry_id` may be linked once (NULL → id).

## 013_cash_transfers.sql (Phase 9)
Table `cash_transfers` (from_book ≠ to_book; fund NOT NULL iff that side is Ice Cream; amount 1..10^12; R-FD, immutability except `posted → void`, delete guard). `trg_cash_entries_transfer_link`: a `transfer_out`/`transfer_in` entry must carry an existing `transfer_id` and sit in the right book/fund for its side, and no other type may carry a `transfer_id` (`TRANSFER_LEG_MISMATCH`). `trg_owner_drawings_cash_amount`: a cash drawing must be 1..10^12 cents (goods drawings of 0 still allowed) — no edit to migration 005 was needed.

## 014_icecream.sql (Phase 10)
Tables `icecream_days` (sum CHECK `C + E + profit_share = sales`, negative share needs `negative_confirmed`, one posted day per date through the partial unique index `ux_icecream_days_posted`), `icecream_sales` (append-only item lines), `icecream_payments` (electricity-category CHECK `lower(trim(category)) <> 'electricity'`, E4), `icecream_fund_moves` (three-way sign/split CHECK: release / re-allocation / Cost↔Electricity re-label). `DAY_CLOSED` triggers on insert of the three record tables and on the void (`posted → void`) of days and fund moves (a fund move writes no cash entry, so the `cash_entries` trigger alone would not protect it). Payments are protected on insert only here; their void writes reversal cash entries, which the `cash_entries` trigger already guards.

## 015_category_per_book.sql (category management)
`categories` is rebuilt so that a category name is unique **per book, case-insensitively** (`UNIQUE INDEX ux_categories_book_name ON categories(book, name COLLATE NOCASE)`) instead of globally: "Pens" may exist in Shop and in Telecom, but not twice in the same book. Ids, `is_default`, `active`, timestamps and every `products.category_id` link are preserved exactly. The two migration-003 triggers (`trg_categories_default_locked`, `trg_categories_book_has_products`) are recreated unchanged, and a new `trg_categories_no_delete` (`CATEGORY_DELETE_FORBIDDEN`) refuses any `DELETE` - a category is retired with `active = 0`, never removed.

How the rebuild is done safely: the runner executes the file in a transaction with `foreign_keys` ON (which cannot be switched off inside a transaction), and `ALTER TABLE ... RENAME` would fail because triggers on `products` mention `categories`. So the rows are parked in a TEMP table, `categories` is dropped and re-created **under its own name** (no rename), and the rows are re-inserted with their ids. With `PRAGMA defer_foreign_keys = ON` the products that pointed at the dropped parent count as deferred violations that the re-insert clears. The AUTOINCREMENT counter is restored. The file ends with a guard (an insert into a temp table with a `CHECK (ok = 1)`) that aborts - and rolls back the whole migration - if any category row differs from the original or `pragma_foreign_key_check` returns anything.

**Rollback:** forward-only. To undo, restore the backup the app takes automatically at start-up before 015 ran.

## 018_external_backups.sql (external backups, decision 11)
Tables `backup_settings` (at most one row, `id = 1`, created when a folder is first set - the table starts empty; `external_dir` NULL = not configured; `updated_at` is when the folder was last set, used for the "configured but never copied for 7 days" rule; delete guard `BACKUP_SETTINGS_DELETE_FORBIDDEN`) and `external_backup_log` (append-only: `status` ok / failed / skipped; `ok` needs a target name, size and a 64-hex SHA-256; `failed` needs an error text; update and delete are refused with `EXTERNAL_BACKUP_LOG_APPEND_ONLY`). Nothing existing is changed. The status shown in the app (ok / not_configured / drive_missing / failed / stale) is derived from these rows plus a live check of the folder, never stored.

**Rollback:** forward-only. To undo, restore the backup the app takes automatically at start-up before 018 ran.
## 016_closed_day_ordering.sql (closed-day ordering protection, BUSINESS_RULES section 8, approved 2026-11-13)
**Why:** a daily closing freezes a book's balance for that day, but an entry dated *earlier* than a closed day still changed the running balance, so the closed day's stored snapshot could drift. A write dated earlier than the **latest currently-closed day** of its book is now refused `BACKDATE_BEFORE_CLOSED_DAY`; a write exactly on a closed day stays `DAY_CLOSED`; later dates and books without closed days are unaffected; a reopened day (`reopened_at` set and not re-closed) no longer counts. The owner reopens the later closed day(s) first (audited).

**What it changes (no new tables; older migrations untouched, triggers are dropped and created again):**
- `trg_cash_entries_day_closed` (012) - same name, stronger: fires when any closed day of the entry's book has `business_date >= NEW.business_date`; aborts `DAY_CLOSED` when that day is the entry's own date, otherwise `BACKDATE_BEFORE_CLOSED_DAY`. A void's reversal row copies the original business date, so it follows the same rule. Closing a day **without** a count posts no cash entry and stays allowed; a closing whose count posts a `cash_adjustment` dated D is refused when a later day is already closed (the service answers the same code first, and a count with no difference posts no entry and is allowed).
- The Ice Cream record triggers of 014 (`trg_icecream_days_day_closed`, `..._day_closed_void`, `trg_icecream_payments_day_closed`, `trg_icecream_fund_moves_day_closed`, `..._day_closed_void`) - same extension (insert, and the void of days and moves judged on the record's own date).

**Service side:** `services/day-closing.ts` `assertDayOpen` (one indexed probe per touched book, `closedDayProbe` in `daily-closings.repo.ts`) is the single shared check every write service already calls; `mapCashAbort` maps the new abort to the same 409 (without dates, as the trigger cannot carry them). Both use the (book, business_date) unique index, so the check is one range probe.

**Rollback:** forward-only (restore the start-up backup). Dropping the new triggers and re-creating the 012/014 versions would restore the old behaviour.

## 021_external_backup_state.sql (external backup status and bounded failure log, hardening M5 + M6)
**Why:** the status was derived only from the append-only `external_backup_log`. (M5) A run that found every backup already on the drive wrote nothing, so "Copy backup now" could never clear the seven-day warning it asked for. (M6) While a drive stayed full, read-only or missing, every 10-minute pass appended a failed row per pending backup (up to ~4,300 rows a day), and an append-only table cannot be trimmed.

**What it adds (nothing existing is changed; `external_backup_log` and `backup_settings` keep every row and every trigger):** the mutable table `external_backup_state`, one row per external **folder** (primary key = folder path, case-insensitive): `first_seen_at` (when the folder became the reference), `last_attempt_at`, `last_success_at` (a file was really copied), `last_sync_at` (the folder was available and **every** start-up/manual backup was present and verified, even if nothing new was written), `consecutive_failures`, `total_failures`, `last_error_code`, `last_error_message`, `first_failure_at` (start of the current failure series), `last_failure_logged_at`. CHECKs: counters are non-negative, `consecutive_failures <= total_failures`, a failing series has a `first_failure_at`.
**Data carried over:** for the folder currently configured, `last_success_at` / `last_sync_at` come from the newest `ok` (and for the sync time also `skipped`) log row, a trailing series of failed rows becomes the current failure series; with no folder configured the table starts empty. Nothing is invented.

**How the application uses it:** every run (start-up/manual backup, timer, Copy backup now, setting a folder) updates the row of the current folder. Status (`ok` synchronized / `not_configured` / `drive_missing` / `failed` / `stale`) is computed from it: `stale` only when no synchronization was confirmed for 7 days (a never-synchronized folder counts from the day it was set). Choosing another folder deletes the state of every other folder and starts a fresh row, then synchronizes at once in the background. The append-only log gets a row only on a change: a file really copied, the first success after a logged failure series, and a failure at most once per (error text, source file) per 24 hours; repeated identical failures only increment the counters. The 10-minute timer finding the drive simply absent is counted but not logged.
**Restore:** the state is ordinary data of the database file, so a restored backup carries its own folder and state (the next run corrects it). Restoring a backup made before 021 runs the migration, which rebuilds the row from that file's log.

**Rollback:** forward-only (restore the start-up backup taken before 021 ran). Dropping the table would restore the old derived-from-log behaviour only together with the old program.

## Rules of thumb for a new migration
- Next number, three digits, lower-case name; never edit an applied file (the checksum would stop startup).
- Money in integer cents, rates in basis points, dates as `YYYY-MM-DD` text with the strict CHECK, timestamps from `strftime('%Y-%m-%dT%H:%M:%fZ','now')`.
- Business documents: `status`, `voided_at`, `void_reason`, `client_ref UNIQUE`, R-FD insert trigger, immutability trigger (only `posted → void`), `BUSINESS_DATE_IMMUTABLE`, `POSTED_AT_IMMUTABLE`, `RECORD_DELETE_FORBIDDEN`. Ledgers: append-only triggers.
- Compare nullable columns with `IS NOT NULL` / `IS` inside CHECKs and triggers (a NULL result passes a CHECK).
- Add a section here and in `DATABASE_SCHEMA.md`.

## 017_void_sales_return.sql - void a sales return (BUSINESS_RULES section 4, rule R-VR)
**Why:** the owner approved taking a posted sales return back (a mistake, the customer changed their mind). Nothing that exists is edited or deleted (R1, C6): the return is only marked `void` and *new* reversal rows are added to the stock and cash ledgers by the service (`services/sales-return-void.ts`). This migration makes the database itself guarantee the parts that must never go wrong, even for a bug or a hand-typed statement. Additive only; the triggers it changes are dropped and re-created **under the same name** with the same behaviour plus one narrow exception.

**What it adds**
- `sales_returns.status` (`posted`/`void`, default `posted`, so every old return stays posted), `voided_at`, `void_reason`, and one CHECK: a posted return has neither void field, a void return has both.
- `trg_sales_returns_no_update` (same name and message `sales_returns is append-only`): every column is still frozen; the **only** allowed update is `posted -> void` carrying `voided_at` and `void_reason` and changing nothing else. A void return never changes again. `trg_sales_returns_no_delete` and the `sales_return_items` append-only triggers are untouched.
- `trg_sales_returns_void_newest` (`RETURN_NOT_NEWEST`): a return can become void only if no *newer posted* return shares one of its sale lines (R-VR 1; newest = highest id = posting order). The last return of a line takes the exact remainder (C5), so the order matters.
- `trg_sales_returns_void_effects` (AFTER the status change): lowers `sale_items.returned_qty` of each line by exactly the returned quantity (R-VR 7) and voids the damaged-return `stock_losses` row(s) of that return with the return's `voided_at`/`void_reason` (R-VR 6; that loss has no stock movement).
- `trg_sale_items_immutable` (re-created, same name): identical to migration 006, except that `returned_qty` may now go **down**, and only to exactly the quantity of the lines of *posted* returns and only for a line that has a voided return. Invariant: `returned_qty = sum(qty of POSTED return lines)`.
- `trg_sales_return_items_extra_exceeds` (re-created, same name, migration 008's C13 backstop): now sums the extra cost of *posted* returns only, so a voided return no longer uses up the line's extra cost. The `RETURN_EXCEEDS_SOLD` backstop already compares with `returned_qty`, which now follows the same rule.
- `trg_stock_losses_damaged_return_void_guard` (`DAMAGED_RETURN_LOSS`): a damaged-return loss can be voided only after its return is void (the cascade above does it); the service keeps its own guard for direct voids.
- Reversal-row guards: `trg_stock_movements_return_reversal_void` (`RETURN_NOT_VOID`: a stock movement of a return that takes units or value out - qty <= 0 of type `sale_return` or the value-only `adjustment` sweep - needs the return to be void), `trg_stock_movements_return_reversal_cap` (`RETURN_REVERSAL_EXCEEDS`: per product, the units taken out can never exceed the resalable units the return restocked, so a double reversal is impossible), `trg_cash_entries_return_reversal` (`RETURN_REVERSAL_INVALID`: a positive cash entry of a return needs the return to be void, a `reverses_entry_id` pointing at an original entry of the same return, book, type, amount and business date) and the **unique index** `uq_cash_entries_return_reversal` (a refund entry of a return can be reversed at most once).

**How the service uses it (in ONE transaction):** status update (the database lowers the counters and voids the loss) -> per resalable line a `sale_return` movement with negative quantity/value dated like the return (value removed = value restored, limited to the pool value, R4; if the pool then holds no units but value, a value-only `adjustment` sweep is written first) -> the refund reversal cash entry (+refund, same book and type, the return's original business date, `reverses_entry_id` = the original refund row) -> audit row. Reports read `status = 'posted'` returns only; the value difference (restored - removed) is the Stock adjustments component `salesReturnVoidGainCents`, taken from the net `sale_return` movements of void returns (no new column or table).

**Upgrade / rollback:** existing returns become `posted` with no void data; no row is lost. Forward-only; the automatic start-up backup taken before the migration is the way back.
