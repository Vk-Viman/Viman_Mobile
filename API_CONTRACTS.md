# API Contracts

Base path: `/api/v1`. JSON in and out (UTF-8). Money fields end in `Cents` and are **integers**. Rates end in `Bp` (basis points, 600 = 6.00%). Dates are `YYYY-MM-DD`; timestamps are ISO-8601 UTC strings. JSON field names are camelCase, SQL columns are snake_case.

This file describes the API **as built** (schema version 14). Every endpoint below exists in `server/src/routes/`. The JSON-schema bodies in those route files are the source of truth for field names and limits; the TypeScript shapes in `web/src/types/*.ts` mirror the responses.

Contents: [Conventions](#conventions) · [Error codes](#error-codes) · [System](#system) · [Catalog](#catalog) · [Purchases and inventory](#purchases-and-inventory) · [Stocktake, losses, personal use](#stocktake-stock-losses-personal-use) · [Sales](#sales) · [Telecom](#telecom) · [Printing](#printing) · [Opening stock and Excel](#opening-stock-and-excel-import) · [Expenses](#expenses) · [Cash books](#cash-books-opening-balances-cash-counts-daily-closings) · [Capital and cash drawings](#capital-and-cash-drawings) · [Transfers](#cash-transfers) · [Ice Cream](#ice-cream) · [Reports](#reports) · [Dashboard and export pack](#dashboard-and-export-pack) · [Internal module signatures](#internal-module-signatures)

---

## Conventions

**Errors.** Any non-2xx response body is
`{ "error": { "code": "UPPER_SNAKE", "message": "Human readable", "fields": { "<path>": "message" }, ...extra } }`.
`fields` is optional (keys are JSON paths such as `shop.name` or `items.0.productId`). Some errors add top-level keys inside `error` (`originalDate`, `onHand`, `minUnitCostCents`, `book`, `businessDate`, `rows`, `summary`, ...), noted per endpoint. See the [error code index](#error-codes).
- Schema validation failures: `400 VALIDATION_ERROR`, message "Some fields are invalid.", `fields` keyed by path; an unknown property is reported as "Unknown field." against that property's name. A missing or non-JSON body: `400 VALIDATION_ERROR`.
- Unknown route under `/api`: `404 NOT_FOUND` (JSON, never the SPA page).
- Unexpected error: `500 INTERNAL_ERROR`, generic message; details only in the server console.
- While a restore is running every other `/api` request gets `503 RESTORE_IN_PROGRESS`.

**Validation.** Fastify JSON Schema with `additionalProperties: false` on bodies and **no type coercion**: a money field sent as `null` or `"600"` is a 400, never converted. Query-string numbers are digit strings validated by pattern (`^[0-9]{1,9}$`), booleans are exactly `true` or `false`, unknown query parameters are `400`. Path `:id` must be 1–9 digits.

**Paging.** List endpoints take `limit` and `offset` and answer `{ items, total, ... }`. Default and maximum differ per resource (stated below); `limit` outside 1..max is `400 VALIDATION_ERROR` (`fields.limit`). Lists sort newest business date first unless stated.

**Idempotency (`clientRef`).** Every create of a financial record requires `clientRef` (string, 8–64 characters of `A-Za-z0-9_-`; the browser sends a UUID). A repeat with the same `clientRef` returns the original record with `200` instead of `201` and creates nothing. Reusing a `clientRef` for a different record kind or book gives `409 CLIENT_REF_CONFLICT` where the service checks it (sale returns, purchase returns, drawings, capital, opening balances, cash counts, daily closings, Excel opening-stock import). The repeat check is always made within the record's own table; `clientRef` values are unique per table (`client_ref UNIQUE`). A sale cart creates one sale per book, so `clientRef` is unique per `(clientRef, book)`.

**Business date and posting time (BUSINESS_RULES §12).** Every financial record in a response carries `businessDate` (owner-entered), `postedAt` (server time, read-only; a request body containing `postedAt` is a 400) and `backdated: boolean` (business date earlier than the Colombo date of `postedAt`). Reports group by business date; posting-order rules (Ice Cream limits, D4, D2, weighted-average costing) use `postedAt` then `id`. `asOf`, `from`, `to` query parameters are business dates and are **never rejected for being in the future**.

**R-FD, no future dates.** Any financial write whose `businessDate` is later than today in Asia/Colombo is `400 FUTURE_DATE_NOT_ALLOWED`, message "Future-dated transactions are not allowed. Please select today or an earlier date.", with `fields.businessDate` set to the same message. Earlier dates are accepted (backdating is audited and listed in the Backdated report). A malformed or impossible date (for example `2026-02-31`) is `400 VALIDATION_ERROR`, `fields.businessDate`. The web date pickers use `max = today` from `GET /health` (`today`), but the server decides. Database triggers repeat the check as a backstop.

**R-RD, returns.** `POST /sales/:id/returns` and `POST /purchases/:id/returns` with a `businessDate` earlier than the original document's business date: `400 RETURN_BEFORE_ORIGINAL_DATE`, message "The return date cannot be earlier than the original sale date (2026-11-05). Please select 2026-11-05 or a later date (not after today)." (`purchase` for purchase returns), `fields.businessDate` = the same message, and `error.originalDate` = the original date.

**Validation order** for writes: JSON schema → R-FD → (returns: original lookup `404 NOT_FOUND`, then R-RD) → repeat-`clientRef` check (a retry still returns the original) → `DAY_CLOSED` → other business rules (stock, status, limits). Voids check `DAY_CLOSED` right after the record lookup, before `ALREADY_VOID`. Request-level checks that need no database (electricity category, `USE_ICECREAM_PAYMENTS`, `FUND_*`) run as validation before R-FD.

**Transactions and audit.** Every write runs in one transaction containing the business record, its stock movements, cash entries, fund entries and its audit row. Audit entries carry business date and backdated flag for financial records.

**Voids (R1).** `POST /<resource>/:id/void` with `{ "reason": "..." }` (1–200 characters after trimming). The record becomes `void` and the ledgers get **reversal rows** (same type, negated amounts, `reversesEntryId` set, the original's business date, posting time = now). Nothing is edited or deleted. A second void is `409 ALREADY_VOID`. A void in a closed day is `409 DAY_CLOSED`. Voiding a sale or purchase that has returns is `409 HAS_RETURNS`.

**Warnings (R13) never block.** Cash-out writes return `warnings: [{ code, message, book, balanceCents, fund? }]` with codes `NEGATIVE_CASH_BALANCE` (a book's balance is below zero after the write), `NEGATIVE_FUND_BALANCE` (an Ice Cream fund is below zero), `ICECREAM_FUNDS_MISMATCH` (only from `GET /cashbooks` and `GET /icecream/funds`; the fund total differs from the Ice Cream book). Sales have their own line warnings (below); print sales return `warnings: ['PRICE_BELOW_COST']`; Ice Cream writes may add `EXCESS_COST_OUTSTANDING`.

**Uploads.** `multipart/form-data`. Backup restore: field `file`, up to 200 MB. Opening-stock Excel: field `file`, `.xlsx` only, up to 5 MB. Larger files answer `413 FILE_TOO_LARGE`.

**Excel and report downloads** answer `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` with a `content-disposition: attachment` filename.

**Not implemented.** There is no `GET /go-live` endpoint and no per-resource `DELETE` anywhere (no hard deletes).

---

## Error codes

| Status | Code | Where it appears |
|---|---|---|
| 400 | `VALIDATION_ERROR` | any endpoint (schema, date format, missing file, text length, ranges) |
| 400 | `FUTURE_DATE_NOT_ALLOWED` | every financial write (R-FD) and Excel preview/import with a future date |
| 400 | `RETURN_BEFORE_ORIGINAL_DATE` | sale and purchase returns (R-RD) |
| 400 | `ELECTRICITY_NOT_ALLOWED` | `POST /expenses`, `POST /icecream/payments` |
| 400 | `USE_ICECREAM_PAYMENTS` | `POST /expenses` with `book: "icecream"` |
| 400 | `FUND_REQUIRED`, `FUND_NOT_ALLOWED` | opening balance, capital, cash drawing, transfer, cash count, daily closing |
| 400 | `SAME_BOOK` | transfer with equal books (`fields.toBook`) |
| 400 | `SAME_FUND` | Ice Cream fund move or preview with equal funds |
| 400 | `NOTE_REQUIRED` | cash count / closing with a non-zero difference and no note |
| 400 | `CATEGORY_INACTIVE`, `CATEGORY_BOOK_MISMATCH` | products |
| 400 | `MIXED_BOOKS` | purchase with Shop and Telecom products |
| 400 | `PRODUCT_NOT_STOCKABLE` | purchases, stock losses, goods drawings (service product) |
| 400 | `PRODUCT_NOT_SELLABLE_YET` | `POST /sales` with a `kind = "service"` product ("Service products are not sold in the POS. Use Printing for print and photocopy jobs."; printing uses `/print-sales`) |
| 400 | `PRODUCT_INACTIVE` | `POST /sales` |
| 400 | `PRODUCT_NOT_IN_BOOK` | stocktake item from the other book |
| 400 | `RESTORE_CONFIRM_REQUIRED` | restore without `confirm = "RESTORE"` |
| 400 | `INVALID_FILE`, `INVALID_FILE_TYPE` | Excel upload that is not a readable `.xlsx` |
| 404 | `NOT_FOUND`, `BACKUP_NOT_FOUND` | unknown id / date / route / backup |
| 409 | `DUPLICATE_NAME`, `DUPLICATE_CODE` | catalog and print service types |
| 409 | `DEFAULT_CATEGORY_LOCKED`, `CATEGORY_HAS_PRODUCTS` | categories |
| 409 | `ALREADY_VOID`, `HAS_RETURNS`, `SALE_VOID`, `PURCHASE_VOID` | voids and returns |
| 409 | `NOT_DRAFT` | stocktake edit/complete after the draft stage |
| 409 | `DAY_CLOSED` | every write dated in a closed day of any touched book (`error.book`, `error.businessDate`) |
| 409 | `DAY_ALREADY_CLOSED`, `DAY_NOT_CLOSED` | daily closing / reopen |
| 409 | `OPENING_BALANCE_EXISTS` | second posted opening balance for a book (and fund) |
| 409 | `DAY_EXISTS` | `POST /icecream/days` when the date already has a posted entry |
| 409 | `SPLIT_CONFIRMATION_REQUIRED` | Ice Cream move into Profit above the profit-eligible limit (D4) |
| 409 | `PROVIDER_INACTIVE`, `SERVICE_TYPE_INACTIVE` | reload / top-up on an inactive provider; print sale on an inactive type |
| 409 | `OPENING_BATCH_IN_USE` | voiding an opening-stock batch whose stock was already used |
| 409 | `IMPORT_ALREADY_COMMITTED` | same Excel file bytes already imported (while that batch is posted) |
| 409 | `DAMAGED_RETURN_LOSS` | voiding a stock-loss row that belongs to a damaged sales return |
| 409 | `CLIENT_REF_CONFLICT` | a `clientRef` reused for a different record |
| 409 | `RESTORE_IN_PROGRESS` | second restore (every other request gets 503 during a restore) |
| 413 | `FILE_TOO_LARGE` | uploads over the limits above |
| 422 | `INSUFFICIENT_STOCK` | any outflow above the quantity on hand; `error.onHand` where known |
| 422 | `RETURN_EXCEEDS_SOLD`, `RETURN_EXCEEDS_PURCHASED` | return quantity above what is returnable |
| 422 | `COST_BELOW_AUTOMATIC` | sale line cost per unit below the automatic cost (C13); `error.minUnitCostCents` |
| 422 | `UNIT_COST_REQUIRED` | stocktake gain on a product with no quantity or value (C10) |
| 422 | `NEGATIVE_PROFIT_UNCONFIRMED` | Ice Cream day with S − C − E < 0 and no confirmation |
| 422 | `ITEMS_TOTAL_MISMATCH` | Ice Cream day items not adding up to `salesCents` |
| 422 | `VOID_BREAKS_RELEASE` | Ice Cream void guard (D2) |
| 422 | `DUPLICATE_PRODUCT`, `INVALID_PRODUCT` | opening stock entry |
| 422 | `IMPORT_HAS_ERRORS` | Excel import with any bad row (nothing saved; `error.rows`, `error.summary`, `error.importRunId`, `error.fileSha256`) |
| 422 | `MISSING_SHEET`, `MISSING_HEADERS`, `EMPTY_FILE`, `TOO_MANY_ROWS` | Excel file structure (more than 5,000 stock rows) |
| 422 | `RESTORE_INVALID_FILE`, `RESTORE_INTEGRITY_FAILED`, `RESTORE_SCHEMA_MISSING`, `RESTORE_SCHEMA_TOO_NEW` | restore validation |
| 500 | `BACKUP_FAILED`, `RESTORE_FAILED`, `INTERNAL_ERROR` | server-side failure |
| 503 | `RESTORE_IN_PROGRESS` | any `/api` call while a restore swaps the database |

---

## System

### `GET /health`
`200` `{ "status": "ok", "appVersion": "0.1.0", "schemaVersion": 14, "time": "<ISO UTC>", "today": "YYYY-MM-DD" }`. `today` is the Colombo business date. `appVersion` is read from `server/package.json`.

### `GET /settings`
`200`
```json
{
  "shop": { "name": "Viman Mobile", "address": "162 Padiliyathuduwa Rd, Hunupitiya, Wattala", "phone": "+94 71 900 4044", "email": "viman.mobile.shop@gmail.com" },
  "rates": { "reloadCommissionBp": 600, "ezcashCommissionBp": 80 },
  "printDefaults": [ { "code": "BW_1S", "name": "B/W print – one side", "priceCents": 1500, "costCents": 650 }, "... 7 items, see DATABASE_SCHEMA.md ..." ],
  "updatedAt": null
}
```
The values shown are the built-in defaults, used when no row is stored. `updatedAt` is the latest `updated_at` across stored sections (null if none).
**`printDefaults` is stored and shown read-only in Settings (labelled "Initial price list, kept for reference; not used for sales") but not read by any other service.** The prices and standard costs actually used for printing are the `print_service_types` rows (see [Printing](#printing)); editing `printDefaults` does not change them.

### `PUT /settings`
Body: any subset of `shop`, `rates`, `printDefaults` (at least one). A section that is present **replaces that section entirely**.
- `shop`: `name` required, 1–100 (trimmed); `address` ≤ 200; `phone` ≤ 30; `email` ≤ 100, empty or containing `@`.
- `rates`: both `reloadCommissionBp` and `ezcashCommissionBp` required, integers 0–10000.
- `printDefaults`: array 1–30; `code` `^[A-Z0-9_]{1,20}$`, unique within the list; `name` 1–60; `priceCents`, `costCents` integers 0–100000000.

`200` the full settings object. One audit row per section that actually changed (`entity: "settings"`, `entityId` = section, `action: "update"`, before/after = section JSON); unchanged sections write nothing.

### `GET /audit-logs?entity=&limit=&beforeId=`
`entity` exact match; `limit` 1–200 (default 50); `beforeId` returns rows with `id < beforeId`. Newest first.
`200` `{ "items": [ { "id", "at", "postedAt" (= at), "entity", "entityId", "action", "before", "after", "note", "businessDate" (null for non-financial entries), "backdated" } ], "nextBeforeId": number|null }`.

### Backups
`GET /backups` → `{ items: [{ name, reason: "startup"|"manual"|"pre-restore", sizeBytes, createdAt }] }`, newest first; only files matching `^viman-\d{8}-\d{6}-(startup|manual|pre-restore)(-\d{1,3})?\.db$` are listed (the `-N` suffix appears when two backups land in the same second).
`POST /backups` (no body) → `201 { item }`; `500 BACKUP_FAILED`. Rotation after each backup keeps the newest 30 start-up/manual backups and the newest 10 pre-restore copies.
`POST /backups/restore`, two forms:
1. JSON `{ "name": "<backup file name>", "confirm": "RESTORE" }`.
2. `multipart/form-data` with `confirm=RESTORE` and a `file` field (a `.db` file, ≤ 200 MB).

`200 { "restoredFrom": "<name>" | "upload:<file name>", "safetyBackup": "<name>", "schemaVersion": 14 }`. Errors: `400 RESTORE_CONFIRM_REQUIRED`, `400 VALIDATION_ERROR` (bad name, no file), `404 BACKUP_NOT_FOUND`, `413 FILE_TOO_LARGE`, `422 RESTORE_INVALID_FILE` (not a SQLite file), `422 RESTORE_INTEGRITY_FAILED` (`integrity_check` not `ok`), `422 RESTORE_SCHEMA_MISSING` (no `schema_migrations`, `settings` or `audit_logs`), `422 RESTORE_SCHEMA_TOO_NEW` (backup newer than this program), `500 RESTORE_FAILED` (the previous data was put back from the safety backup). Sequence: copy to a candidate file → validate (live database untouched on failure) → safety backup → close, remove `-wal`/`-shm`, atomic rename over `viman.db` → reopen → migrate (an older backup is upgraded) → audit entry `backup` / `restore`. Names are validated before any file access (no path traversal).

---

## Catalog

Catalog data is not financial: no `clientRef`, no business date, no R-FD. Every write is audited (entity `category` | `product` | `supplier`, action `create`/`update`, before/after = the item JSON). Nothing is deleted: retire with `active: false`. A PUT that changes nothing writes no audit row. Common errors: `400 VALIDATION_ERROR`, `404 NOT_FOUND`, `409 DUPLICATE_NAME` (case-insensitive, after trimming; `fields.name`), `409 DUPLICATE_CODE` (`fields.code`).

### Categories
`Category` = `{ id, name, book: "shop"|"telecom", isDefault, active, productCount, createdAt, updatedAt }` (`productCount` includes inactive products).
- `GET /categories?active=&book=` → `{ items }`, ordered by book (shop first) then name.
- `POST /categories` `{ name (1–60), book }` → `201 { item }`.
- `PUT /categories/:id` any of `{ name, book, active }` (at least one) → `200 { item }`. The 12 built-in categories keep their name and book forever (`409 DEFAULT_CATEGORY_LOCKED`) but can be deactivated. The book of an owner-created category can change only while it has no products (`409 CATEGORY_HAS_PRODUCTS`).

Built-in categories: Shop — Phone Accessories, Tempered Glass, Phone Covers, Electronics, Stationery, Snacks and Drinks, Party Items, Perfume, Pooja Items, SIM, Other. Telecom — Scratch Cards.

### Products
`Product` = `{ id, code|null, name, description, categoryId, categoryName, kind: "stock"|"service", book, sellPriceCents, minPriceCents, reorderLevel, active, qtyOnHand, stockValueCents, avgUnitCostCents|null, lowStock, createdAt, updatedAt }`.
`book` comes from the category. `avgUnitCostCents = mulDivRound(stockValueCents, 1, qtyOnHand)` when quantity > 0 (display only). `lowStock` = stock product, active, `reorderLevel > 0` and `qtyOnHand <= reorderLevel`.
- `GET /products?q=&book=&categoryId=&lowStock=&active=&limit=&offset=` → `{ items, total }`. `q` matches name or code (case-insensitive substring, wildcards escaped). `limit` 1–500 (default 100). Ordered by name, then id.
- `GET /products/:id` → `{ item }`.
- `POST /products` `{ code?, name, description?, categoryId, kind: "stock"|"service", sellPriceCents, minPriceCents, reorderLevel? }` → `201 { item }`. `name` 1–120; `code` 1–30 if given (empty string = no code), unique case-insensitively; `description` ≤ 500; prices integers 0–999999999 with `minPriceCents <= sellPriceCents` (`fields.minPriceCents`); a service must have `reorderLevel` 0. Category must exist and be active (`400 CATEGORY_INACTIVE`). Quantity and value start at 0 (stock arrives through purchases, opening stock, stocktake gains).
- `PUT /products/:id` any of `{ code, name, description, categoryId, sellPriceCents, minPriceCents, reorderLevel, active }` → `200 { item }`. `kind` and `book` never change (sending `kind` is a 400); the category may change only within the same book (`400 CATEGORY_BOOK_MISMATCH`). `code: null` or `""` clears the code. Price rules are checked on the merged values.
- `GET /products/:id/movements` is listed under [Inventory](#stock-movements-and-reconciliation).

### Suppliers
`Supplier` = `{ id, name, phone, notes, active, createdAt, updatedAt }`.
- `GET /suppliers?q=&active=` → `{ items }` (name order; `q` matches name or phone).
- `POST /suppliers` `{ name (1–120), phone? (≤ 30), notes? (≤ 500) }` → `201 { item }`.
- `PUT /suppliers/:id` any of `{ name, phone, notes, active }` → `200 { item }`.

---

## Purchases and inventory

Costing: weighted average per product (BUSINESS_RULES §3). Stock moves only through the inventory engine, which inserts `stock_movements`; a database trigger updates the product's cached quantity and value.

### Purchases
`PurchaseItem` = `{ id, productId, productName, packs, packSize, units, lineTotalCents, unitCostCents, returnedUnits }` (`units = packs × packSize`; `unitCostCents` is display only).
`Purchase` = `{ id, businessDate, postedAt, backdated, supplierId|null, supplierName|null, billNo, book, totalCents, status, notes, voidedAt|null, voidReason|null, clientRef, items, returns }`.
`PurchaseReturn` = `{ id, purchaseId, businessDate, postedAt, backdated, refundCents, note, clientRef, items: [{ id, purchaseItemId, productId, productName, units, valueCents }] }`.

- `POST /purchases` `{ businessDate, supplierId?, billNo? (≤ 40), items: [{ productId, packs (1–10^6), packSize (1–10^6), lineTotalCents (0–99999999999) }] (1–100), notes? (≤ 500), clientRef }` → `201 { item, warnings }`.
  - Products must exist, be active and `kind = "stock"` (`400 PRODUCT_NOT_STOCKABLE`); all of one book, else `400 MIXED_BOOKS` "Shop and Telecom items cannot be on one bill — please split into two bills." (R11). The same product may appear on several lines. `supplierId` must exist and be active.
  - Effects: `purchases` + `purchase_items`; per line a `purchase` movement (`+units`, `+lineTotalCents`); one `purchase_payment` cash entry (`−totalCents`, the purchase's book) when the total is above 0; audit `purchase`/`create`.
- `GET /purchases?from=&to=&book=&supplierId=&status=&q=&limit=&offset=` → `{ items, total }` (items include lines and returns). `q` matches `billNo`. `limit` 1–200 (default 50).
- `GET /purchases/:id` → `{ item }`.
- `POST /purchases/:id/void` `{ reason }` → `200 { item }`. `409 HAS_RETURNS`; `422 INSUFFICIENT_STOCK` ("Some of this purchase has already been sold or removed."). Per line a `purchase_void` movement removes `units` at `min(lineTotalCents, pool value)` (R4), with a value-only `adjustment` sweep movement when the quantity reaches 0 with value left; a reversal of the payment cash entry.
- `POST /purchases/:id/returns` `{ businessDate, items: [{ purchaseItemId, units }] (1–100, each item once), note?, clientRef }` → `201 { item: PurchaseReturn, purchase, warnings }`. Errors: R-RD, `409 PURCHASE_VOID`, `422 RETURN_EXCEEDS_PURCHASED` (`fields["items.N.units"]`), `422 INSUFFICIENT_STOCK`. Refund per item (C7): `mulDivRound(lineTotalCents, units, item.units)`, except the return that completes the item takes the remaining value. Effects: a `purchase_return` movement per item at `min(purchase-cost value, pool value)` (R4, with sweep); one `purchase_refund` cash entry (`+refundCents`) when above 0. The difference between refund and value removed from stock shows up as a Stock adjustment in the P&L.

### Stock movements and reconciliation
`StockMovement` = `{ id, productId, businessDate, postedAt, type, qtyDelta, valueDeltaCents, unitCostCents|null, refTable|null, refId|null, reason }`; `type` is one of `opening`, `purchase`, `purchase_return`, `purchase_void`, `sale`, `sale_return`, `sale_void`, `personal_use`, `loss`, `stocktake_gain`, `stocktake_loss`, `adjustment` (`sale_void` is allowed by the database but is not written: a sale void reuses type `sale` with negated amounts, C6).
- `GET /products/:id/movements?from=&to=&type=&limit=&offset=` → `{ items, total, product }`, newest posting first; `limit` 1–200 (default 50).
- `GET /inventory/reconciliation` → `{ ok, checkedProducts, mismatches: [{ productId, name, cacheQty, movementQty, cacheValueCents, movementValueCents }] }`. Must always be `ok: true`.
- `GET /inventory/valuation?book=&categoryId=&asOf=&includeZero=&includeInactive=` → `{ asOf|null, items: [{ productId, code, name, categoryId, categoryName, book, active, qty, valueCents, avgUnitCostCents|null }], totals: { qty, valueCents, byBook: { shop, telecom } } }`. `asOf` is a business date: quantities and values are the sum of movements dated on or before it; omitted (or later than today) the live pool is used. `includeZero` default false, `includeInactive` default true. Ordered by name.

---

## Stocktake, stock losses, personal use

All writes: one transaction with the record, the movement(s) from the inventory engine and the audit row; `clientRef` idempotency. A void writes movements that are the exact negation of the originals (same type, original business date). No cash effect.

### Stocktake
`Stocktake` = `{ id, businessDate, postedAt, backdated, book, status: "draft"|"completed"|"void", notes, completedAt|null, voidedAt|null, voidReason|null, clientRef, items }`; `StocktakeItem` = `{ id, productId, productName, productCode, countedQty, expectedQty, differenceQty, valueDeltaCents|null, gainUnitCostCents|null }`. In a draft, `expectedQty` is the product's current quantity and `valueDeltaCents` is null; a completed stocktake stores the values fixed at completion.
- `POST /stocktakes` `{ businessDate, book: "shop"|"telecom", notes?, items?: [{ productId, countedQty (0–10^9), gainUnitCostCents? (0–99999999999) }] (≤ 500), clientRef }` → `201 { item }` (draft, no stock effect). Items must be stock products of the book (`400 PRODUCT_NOT_IN_BOOK`), no duplicates.
- `PUT /stocktakes/:id` `{ notes?, items? }` (at least one) → `200 { item }`; draft only (`409 NOT_DRAFT`); `items` replaces the whole list.
- `GET /stocktakes?from=&to=&book=&status=&limit=&offset=` → `{ items, total }`; `limit` 1–100 (default 50). `GET /stocktakes/:id` → `{ item }`.
- `POST /stocktakes/:id/complete` `{}` → `200 { item }`. In one transaction, per item against the live pool: a shortage is a `stocktake_loss` at weighted average; a surplus is a `stocktake_gain` valued at `mulDivRound(pool value, gain, pool qty)`, or, when the pool has no quantity or no value (C10), at `gain × gainUnitCostCents` (`422 UNIT_COST_REQUIRED` if missing; nothing is posted). Equal counts post nothing. A draft with no items is `400 VALIDATION_ERROR`.
- `POST /stocktakes/:id/void` `{ reason }` → `200 { item }`. A draft is simply cancelled; a completed stocktake is reversed (`422 INSUFFICIENT_STOCK` if gained stock was already used).

### Stock losses
`StockLoss` = `{ id, businessDate, postedAt, backdated, productId, productName, book, qty, costCents, unitCostCents, reason: "damaged"|"lost"|"expired"|"other", note, source: "manual"|"damaged_return", salesReturnId|null, status, voidedAt|null, voidReason|null, clientRef }`.
- `POST /stock-losses` `{ businessDate, productId, qty (1–10^9), reason, note? (≤ 500), clientRef }` → `201 { item }`. Stock product required (`400 PRODUCT_NOT_STOCKABLE`; inactive products are allowed); `422 INSUFFICIENT_STOCK`. One `loss` movement at weighted average; `costCents` is the value removed.
- `GET /stock-losses?from=&to=&productId=&book=&reason=&status=&limit=&offset=` → `{ items, total, totalCostCents }` (total over posted rows matching the filter). `GET /stock-losses/:id`.
- `POST /stock-losses/:id/void` `{ reason }` → `{ item }`. Refused with `409 DAMAGED_RETURN_LOSS` for rows created by a damaged sales return (they belong to the return).

### Goods drawings (personal use) and cash drawings
`Drawing` = `{ id, businessDate, postedAt, backdated, book, fund|null, kind: "goods"|"cash", amountCents, productId|null, productName|null, qty|null, note, status, voidedAt|null, voidReason|null, clientRef }`. For goods, `amountCents` is the stock **cost** removed, never the selling price.
- `POST /drawings` `{ kind, businessDate, clientRef, note? }` plus:
  - `kind: "goods"`: `productId`, `qty` (1–10^9). Stock product required (`400 PRODUCT_NOT_STOCKABLE`). One `personal_use` movement at weighted average. No cash, no revenue, no COGS, no expense; not a stock loss. `book`, `fund` and `amountCents` are rejected.
  - `kind: "cash"`: `book`, `fund` (iff `icecream`), `amountCents` (1–10^12). Cash-out `drawing_cash`; Ice Cream also writes a fund entry. `400 FUND_REQUIRED` / `FUND_NOT_ALLOWED`.
  → `201 { item, warnings }`.
- `GET /drawings?kind=&from=&to=&book=&productId=&status=&limit=&offset=` → `{ items, total, totalAmountCents, totals: { amountCents, goodsCents, cashCents } }`; `limit` 1–200 (default 50). `GET /drawings/:id` → `{ item }`.
- `POST /drawings/:id/void` `{ reason }` → `{ item }` (reversal movement or reversal cash entry; original business date).

---

## Sales

Scope: stock products only. Shop goods are book `shop`, line type `goods`; scratch cards (Telecom) are book `telecom`, line type `card`. A `kind = "service"` product on a sale line is refused (`400 PRODUCT_NOT_SELLABLE_YET`); printing and photocopying are sold through `/print-sales`, reloads and EZCash through `/reload-sales` and `/ezcash-sales`. Payment is always cash.

`SaleItem` = `{ id, lineNo, lineType, productId, productName, productCode, qty, unitPriceCents, unitCostCents, revenueCents, cogsCents, extraCostCents, chargedCostCents, returnedQty }` — `revenueCents = qty × unitPriceCents`; `cogsCents` is the stock value actually removed at the weighted average and never changes afterwards; `unitCostCents` is the display snapshot of the **automatic** unit cost; `chargedCostCents = cogsCents + extraCostCents`.
`Sale` = `{ id, businessDate, postedAt, backdated, book, totalCents, cogsCents, extraCostCents, chargedCostCents, grossProfitCents, status, notes, voidedAt|null, voidReason|null, clientRef, items, returns }` — `grossProfitCents = totalCents − chargedCostCents`, before returns.
`SaleReturn` = `{ id, saleId, businessDate, postedAt, backdated, refundCents, cogsReversedCents, extraCostReversedCents, note, clientRef, items: [{ id, saleItemId, productId, productName, qty, resalable, revenueCents, cogsCents, extraCostCents }] }`.

- `POST /sales` `{ businessDate, items: [{ productId, qty (1–10^6), unitPriceCents (0–999999999), unitCostCents? (0–999999999) }] (1–100), notes? (≤ 500), clientRef }` → `201 { sales: Sale[], warnings }`.
  - The server splits the cart by product book into **one sale per book** (shop first, then telecom), lines in cart order. Per line, `sale` movement at the weighted average; quantity is checked per product across the whole cart (`422 INSUFFICIENT_STOCK`, `fields["items.N.qty"]`, `error.onHand`; nothing is saved). Products must be active (`400 PRODUCT_INACTIVE`).
  - Cash: one entry per sale with a total above 0: `sale_goods` (+, shop) or `card_sale` (+, telecom).
  - **Extra cost (C13):** `unitCostCents` is the cost per unit to charge. Omitted or equal to the automatic cost → extra 0. It may be raised, never lowered: `qty × unitCostCents` below the automatic cost is `422 COST_BELOW_AUTOMATIC` (`fields["items.N.unitCostCents"]`, `error.minUnitCostCents = ceil(cogsCents / qty)`). `extraCostCents = qty × unitCostCents − cogsCents`. The extra creates no stock movement and no cash entry.
  - `warnings` entries `{ code, message, lineIndex }`, never blocking: `PRICE_BELOW_MINIMUM`, `PRICE_BELOW_COST` (against the automatic unit cost), `ZERO_COST` (quantity sold but no cost recorded).
- `GET /sales?from=&to=&book=&status=&productId=&limit=&offset=` → `{ items, total, totals: { revenueCents, cogsCents, extraCostCents, costCents, refundsCents } }` (totals over posted sales matching the filter). `limit` 1–200 (default 50). `GET /sales/:id` → `{ item }`.
- `POST /sales/:id/void` `{ reason }` → `{ item, warnings }` (R13 negative-cash warning after the reversal; never blocks). `409 HAS_RETURNS`. The sale's movements are exactly negated (stock returns at the original snapshot value) and its cash entry reversed.
- `POST /sales/:id/returns` `{ businessDate, items: [{ saleItemId, qty (1–10^6), resalable: boolean }] (1–100), note?, clientRef }` → `201 { item: SaleReturn, sale, warnings }`.
  - Errors: R-RD, `409 SALE_VOID`, `422 RETURN_EXCEEDS_SOLD`; each line once per request and belonging to the sale (`400`).
  - Values (C5): revenue, automatic cost and extra cost each use `mulDivRound(amount, qty, item.qty)`; the return that completes the line takes the exact remainder. `refundCents` = Σ revenue portions.
  - **Resalable:** `sale_return` movement, stock back at the automatic snapshot cost only. **Damaged:** no stock movement; revenue and costs are reversed and exactly one `stock_losses` row per damaged line is written (`source: "damaged_return"`, `salesReturnId` set, automatic cost only, the return's business date).
  - Cash: `sale_refund` (−, shop) or `card_refund` (−, telecom) when the refund is above 0.

---

## Telecom

Cash-only module (R14: no float or wallet balances). Revenue is the commission only. Rates are snapshotted on every sale.

- `GET /reload-providers` → `{ items: [{ id, name, commissionBp (effective: own rate or the shop default), ownCommissionBp (null = use default), active }] }`. Providers (seeded): Dialog, Mobitel, Hutch, Airtel.
- `PUT /reload-providers/:id` `{ commissionBp: integer 0–10000 | null, active: boolean }` → `{ item }`; audited; never changes existing sales.
- `POST /reload-sales` `{ businessDate, providerId, salesCents (1–10^12), extraCents? (0–10^12, default 0), notes?, clientRef }` → `201 { item }`. `commissionCents = mulDivRound(salesCents, rateBp, 10000) + extraCents`, where `rateBp` is the provider's own rate or `settings.rates.reloadCommissionBp` (default 600). Cash `reload_collection` +`salesCents` (telecom). `409 PROVIDER_INACTIVE`.
- `GET /reload-sales?from=&to=&providerId=&status=&limit=&offset=` → `{ items, total, totals: { salesCents, commissionCents, extraCents } }` (posted rows). `GET /reload-sales/:id`; `POST /reload-sales/:id/void` → `{ item, warnings }`.
  `ReloadSale` = `{ id, businessDate, postedAt, backdated, providerId, providerName, salesCents, commissionBp, extraCents, commissionCents, notes, status, voidedAt, voidReason, clientRef }`.
- `POST /ezcash-sales` `{ businessDate, billTotalCents (1–10^12), notes?, clientRef }` → `201 { item }`. Provider is Dialog automatically. `commissionCents = mulDivRound(billTotalCents, rateBp, 10000)` with `settings.rates.ezcashCommissionBp` (default 80); Dialog's own reload rate is not used and an inactive Dialog does not block EZCash. Cash `ezcash_collection` +`billTotalCents`.
- `GET /ezcash-sales` (same filters without `providerId`; `totals: { billTotalCents, commissionCents }`), `GET /ezcash-sales/:id`, `POST /ezcash-sales/:id/void` → `{ item, warnings }`.
- `POST /telecom/topups` `{ businessDate, kind: "provider_topup"|"wallet_topup", providerId? (required for provider_topup, forbidden for wallet_topup), amountCents (1–10^12), notes?, clientRef }` → `201 { item, warnings }`. Cash-out `provider_topup` or `wallet_topup` (telecom). `409 PROVIDER_INACTIVE`; wrong `providerId` usage is `400 VALIDATION_ERROR` (`fields.providerId`).
- `GET /telecom/topups?from=&to=&kind=&providerId=&status=` → `{ items, total, totals: { providerTopupCents, walletTopupCents, totalCents } }`; `GET /telecom/topups/:id`; `POST /telecom/topups/:id/void`.
- `GET /telecom/summary?from=&to=` → `{ from|null, to|null, providers: [{ providerId, name, reloadSalesCents, reloadCommissionCents (incl. extra), ezcashBillCents, ezcashCommissionCents, topupsCents, commissionRevenueCents }], totals: { reloadSalesCents, reloadCommissionCents, reloadExtraCents, ezcashBillCents, ezcashCommissionCents, providerTopupsCents, walletTopupsCents, topupsCents, commissionRevenueCents } }` (posted rows).
- List paging: default 50, max 200. Scratch cards are ordinary stock products sold in the POS.

---

## Printing

- `GET /print-service-types?active=` → `{ items: [{ id, code, name, priceCents, costCents, active, sortOrder }] }`. Seven types are seeded (codes `BW_1S`, `BW_2S`, `CLR_1S`, `CLR_2S`, `PC_BW_1S`, `PC_BW_2S`, `CUSTOM`; prices and costs in DATABASE_SCHEMA.md).
- `POST /print-service-types` `{ code (^[A-Z0-9_]{2,20}$), name, priceCents, costCents (0–10^9) }` → `201 { item }`; `409 DUPLICATE_CODE`.
- `PUT /print-service-types/:id` `{ name, priceCents, costCents, active }` (all required) → `{ item }`. Codes never change, types are never deleted, past sales are never changed.
- `POST /print-sales` `{ businessDate, serviceTypeId, qty (1–10^6), unitPriceCents? (0–10^9, default = the type's price), notes?, clientRef }` → `201 { item, warnings }`. `unit_cost` is a snapshot of the type's current standard cost; `revenueCents = qty × unitPriceCents`; `cogsCents = qty × unitCostCents`. Cash `sale_service` +revenue (shop). `warnings: ["PRICE_BELOW_COST"]` when the price is below the standard cost. `409 SERVICE_TYPE_INACTIVE`; an unknown type is `400 VALIDATION_ERROR`.
- `GET /print-sales?from=&to=&serviceTypeId=&status=` → `{ items, total, totals: { revenueCents, cogsCents, grossProfitCents } }`; `GET /print-sales/:id`; `POST /print-sales/:id/void` → `{ item, warnings }`.
  `PrintSale` = `{ id, businessDate, postedAt, backdated, serviceTypeId, serviceTypeCode, description, qty, unitPriceCents, unitCostCents, revenueCents, cogsCents, grossProfitCents, status, voidedAt, voidReason, notes, clientRef }`.
- `POST /printing-supplies` `{ businessDate, amountCents (1–10^12), description, clientRef }` → `201 { item, warnings }`. Cash-out `printing_supplies` (shop); **no P&L effect** (R12; the Printing variance report compares supplies spent with standard cost charged).
- `GET /printing-supplies?from=&to=&status=` → `{ items, total, totals: { amountCents } }`; `GET /printing-supplies/:id`; `POST /printing-supplies/:id/void` → `{ item }`.
- List paging: default 50, max 200.

---

## Opening stock and Excel import

Opening stock adds stock without cash, purchase or P&L (BUSINESS_RULES §3). Each batch writes one `opening` movement per line through the inventory engine.

- `POST /opening-stock` `{ businessDate, items: [{ productId, qty (1–10^9), unitCostCents? | totalValueCents? (0–99999999999; give one: the value is the exact entered total, or qty × unit cost) }] (1–1000), notes?, clientRef }` → `201 { item: OpeningBatchDetail }`. `422 DUPLICATE_PRODUCT` (same product twice), `422 INVALID_PRODUCT` (unknown, inactive or service product; `fields["items.N.productId"]`).
- `GET /opening-stock?from=&to=&status=&limit=&offset=` → `{ items: OpeningBatch[], total, totals: { valueCents, lines } }`; `GET /opening-stock/:id` → `{ item }` with `items: [{ productId, productCode, productName, qty, valueCents, unitCostCents }]`.
  `OpeningBatch` = `{ id, businessDate, postedAt, backdated, source: "manual"|"excel", fileName|null, rowCount, totalValueCents, status, notes, voidedAt, voidReason, clientRef }`.
- `POST /opening-stock/:id/void` `{ reason }` → `{ item }`. Reverses the movements; `409 OPENING_BATCH_IN_USE` if any product no longer holds the batch quantity.
- `GET /excel/opening-stock-template` → `.xlsx` (ExcelJS): sheet `Opening stock` with headers `SKU`, `Product name`, `Quantity`, `Unit cost (Rs)`, `Total value (Rs)`, `Notes`, plus sheet `Products` listing the active stock products (SKU, name, category, book). The importer finds columns by these header names; `SKU`, `Quantity`, `Unit cost (Rs)` and `Total value (Rs)` are required.
- `POST /excel/opening-stock/preview` multipart: `file` (`.xlsx`, ≤ 5 MB) and optional `businessDate` (default today). → `{ importRunId, rows: [{ rowNo, sku, productId, productName, qty, unitCostCents, totalValueCents, status: "ok"|"error", issues: [{ code, message }] }], summary: { total, ok, failed, totalValueCents }, fileSha256, alreadyCommitted }`. Writes nothing to stock (an `import_runs` / `import_issues` record is kept). Row issue codes: `MISSING_SKU`, `UNKNOWN_SKU`, `INACTIVE_PRODUCT`, `BAD_QTY`, `BAD_COST`, `DUPLICATE_SKU_IN_FILE`, `FUTURE_DATE_NOT_ALLOWED`. Money cells are parsed as exact decimals (up to 2 places, thousands commas allowed), never as floats. File-level errors: `400 INVALID_FILE`/`INVALID_FILE_TYPE`, `422 MISSING_SHEET`, `MISSING_HEADERS`, `EMPTY_FILE`, `TOO_MANY_ROWS` (limit 5,000 stock rows), `413 FILE_TOO_LARGE`.
- `POST /excel/opening-stock/import` multipart: `file`, optional `businessDate`, required `clientRef`. **All or nothing:** any bad row is `422 IMPORT_HAS_ERRORS` and nothing is saved; otherwise one batch (`source: "excel"`) is committed. `201`/`200 { batch, importRunId, summary }`. `409 IMPORT_ALREADY_COMMITTED` for the same file bytes (SHA-256) while that earlier batch is still posted; a corrected file can be imported after a void.

---

## Expenses

Shop and Telecom only. Ice Cream costs use the Ice Cream endpoints. There is no Electricity category.

- `GET /expenses/categories` → `{ items: [{ value, label }] }`: `water` Water, `rent` Rent, `internet` Internet, `transport` Transport, `repairs` Repairs, `cleaning_supplies` Cleaning supplies, `packaging` Packaging, `stationery` Stationery, `other` Other.
- `POST /expenses` `{ businessDate, book: "shop"|"telecom", category, amountCents (1–10^12), description (required), notes?, clientRef }` → `201 { item, warnings }`. `category` containing only "electricity" (any case or spacing) → `400 ELECTRICITY_NOT_ALLOWED` ("Electricity is paid from the Ice Cream book.", `fields.category`); `book: "icecream"` → `400 USE_ICECREAM_PAYMENTS`; any other unknown category → `400 VALIDATION_ERROR`. Cash-out `expense` in the expense's book.
- `GET /expenses?from=&to=&book=&category=&status=` → `{ items, total, totals: { amountCents } }` (posted rows); `GET /expenses/:id`; `POST /expenses/:id/void` → `{ item }`. Paging default 50, max 200.
  `Expense` = `{ id, businessDate, postedAt, backdated, book, category, amountCents, description, notes, status, voidedAt, voidReason, clientRef }`.

---

## Cash books, opening balances, cash counts, daily closings

`CashBook` = `shop | telecom | icecream`; `IceFund` = `cost | electricity | profit`. For `icecream` a `fund` is required wherever the money moves (`400 FUND_REQUIRED`); for other books it is rejected (`400 FUND_NOT_ALLOWED`).

- `GET /cashbooks` → `{ books: [{ book, balanceCents, lastClosedDate|null, funds? (icecream: { cost, electricity, profit } as plain cents) }], warnings }`. Balances are all-time ledger sums; warnings are `NEGATIVE_CASH_BALANCE`, `NEGATIVE_FUND_BALANCE`, `ICECREAM_FUNDS_MISMATCH`.
- `GET /cashbooks/:book?from=&to=&limit=&offset=` → `{ book, from|null, to|null, openingCents (ledger balance before `from`; 0 when no `from`), inCents, outCents, closingCents (= opening + in − out), items: [{ id, businessDate, postedAt, type, amountCents (signed), runningBalanceCents, fund, refTable, refId, reversesEntryId, note }], total, closedDates, funds? }`. Ordered by business date then id; the running balance is carried correctly across pages. `limit` 1–200 (default 50). For `icecream`, `funds` has per-fund `{ openingCents, inCents, outCents, closingCents }`. `from > to` is `400`.
- `POST /cashbooks/:book/opening` `{ businessDate, amountCents (1–10^12), fund?, note?, clientRef }` → `201 { item, warnings }` (cash-in `opening_balance`; may be backdated to the go-live date). A second posted opening balance for the same book (and fund) is `409 OPENING_BALANCE_EXISTS`; correct a wrong one by voiding it and entering it again. `GET /cashbooks/:book/opening` → `{ items }`.
- `POST /capital-entries/:id/void` `{ reason }` → `{ item, warnings }`. Voids an opening balance or a capital entry (`409 DAY_CLOSED` rules apply).
- `GET /cash-counts/expected?book=&businessDate=` → `{ expectedCents }`: the ledger balance of the book (Ice Cream: the whole book) as of the end of that business date.
- `POST /cash-counts` `{ businessDate, book, countedCents (0–10^12), fund? (required for icecream when the difference is not zero; ignored when it is zero), note? (required when the difference is not zero: `400 NOTE_REQUIRED`), clientRef }` → `201 { item, warnings }`. `item` = `{ id, book, fund, businessDate, postedAt, backdated, expectedCents, countedCents, differenceCents (= counted − expected), note, status, voidedAt, voidReason, cashEntryId, clientRef }`. A non-zero difference posts one `cash_adjustment` cash entry (signed difference, dated the count's business date; Ice Cream also a fund entry of kind `cash_over_short` in the chosen fund). A zero difference posts nothing.
- `GET /cash-counts?book=&from=&to=&status=&limit=&offset=`; `GET /cash-counts/:id`; `POST /cash-counts/:id/void` `{ reason }` → `{ item, warnings }` (reverses the adjustment).
- `POST /daily-closings` `{ book, businessDate, countedCents?, fund?, note?, clientRef }` → `201 { item, count|null, warnings }`. Computes expected as of that date; if `countedCents` is given it always records a cash count first (adjustment included, same rules), then marks the day closed. `409 DAY_ALREADY_CLOSED`. R-FD applies (cannot close a date after today). A retry with the `clientRef` of its saved count returns `200` with `count: null`.
- `POST /daily-closings/:id/reopen` `{ reason (at least 3 characters) }` → `{ item }` (audited; `409 DAY_NOT_CLOSED`). Re-closing updates the same row.
- `GET /daily-closings?book=&from=&to=` → `{ items }`; `GET /daily-closings/status?book=&businessDate=` → `{ isClosed }`. `DailyClosing` = `{ id, book, businessDate, postedAt, closedAt, reopenedAt, reopenReason, expectedCents, countedCents|null, overShortCents, cashCountId|null, isClosed }`.
- **`DAY_CLOSED` (R9).** Every financial write, create **and void**, dated in a closed day of **any book it touches** is `409 DAY_CLOSED`: "That day is closed for the <Shop|Telecom|Ice Cream> cash book. Reopen it first (it will be recorded in the audit log).", with `error.book` and `error.businessDate`. Voids and returns are judged on the record's (return's) own business date. Books touched: sales and purchases → the document's book; stock-only writes (stocktake completion, loss, goods drawing, opening stock) → the book of each product; telecom records → telecom; printing → shop; transfers → both books; Ice Cream records → `icecream`. A stocktake is checked only when completed (or when a completed one is voided). One shared helper (`assertDayOpen`) implements it.

---

## Capital and cash drawings

- `POST /capital` `{ businessDate, book, fund? (iff icecream), amountCents (1–10^12), note?, clientRef }` → `201 { item, warnings }`. Stored as `capital_entries` kind `capital`; cash-in `capital`. Never revenue, never profit-eligible.
- `GET /capital?kind=&book=&from=&to=&status=&limit=&offset=` (`kind` = `capital`, `opening_balance` or `all`) → `{ items, total, totals: { amountCents } }`; `GET /capital/:id` → `{ item }`. Void through `POST /capital-entries/:id/void`.
  `CapitalEntry` = `{ id, businessDate, postedAt, backdated, book, fund|null, kind, amountCents, note, status, voidedAt, voidReason, clientRef }`.
- Cash drawings are `POST /drawings` with `kind: "cash"` (see [Stocktake, losses, personal use](#goods-drawings-personal-use-and-cash-drawings)).

---

## Cash transfers

- `POST /cash-transfers` `{ businessDate, fromBook, toBook, fromFund?, toFund?, amountCents (1–10^12), note?, clientRef }` → `201 { item, warnings }`. `fromBook = toBook` → `400 SAME_BOOK` (`fields.toBook`). `fromFund` is required exactly when `fromBook` is `icecream`, `toFund` exactly when `toBook` is `icecream` (`FUND_REQUIRED` / `FUND_NOT_ALLOWED` on those fields). One transaction writes a `transfer_out` and a `transfer_in` cash entry sharing `transfer_id`, plus Ice Cream fund entries on Ice Cream sides. No P&L effect. The warning is about the source book or fund.
- `GET /cash-transfers?from=&to=&book=&status=&limit=&offset=` (`book` matches either side) → `{ items, total, totals: { amountCents } }`; `GET /cash-transfers/:id`.
- `POST /cash-transfers/:id/void` `{ reason }` → `{ item, warnings }` (warning about the destination book). Writes the opposite pair (4 rows in total, net zero). `409 DAY_CLOSED` if either book's day is closed (names the first closed book).
  `Transfer` = `{ id, businessDate, postedAt, backdated, fromBook, toBook, fromFund, toFund, amountCents, note, status, voidedAt, voidReason, clientRef }`.

---

## Ice Cream

Three-fund system (BUSINESS_RULES §10). Every write is one transaction: the business record, its fund-ledger rows, its Ice Cream cash entries (if cash moves) and an audit row; `clientRef` idempotency; `DAY_CLOSED` applies. **`fund` is required in every body that moves money**; the defaults in §10.2 (Cost for materials, Electricity for the bill, Profit for over/short) are screen presets only.
Every write answers `{ <record>, funds, warnings }` where `funds` is the full `FundsSummary` below and `warnings` may contain `NEGATIVE_CASH_BALANCE`, `NEGATIVE_FUND_BALANCE`, `EXCESS_COST_OUTSTANDING` (fund moves return only the fund and excess warnings). List paging for days, payments, moves and the fund ledger: default 100, max 500.

**Daily entries** (`IceDay` = `{ id, businessDate, postedAt, backdated, salesCents, costAllocCents, electricityAllocCents, profitShareCents, negativeConfirmed, notes, status, voidedAt, voidReason, clientRef, items: [{ id, itemName, qty, unitPriceCents, lineTotalCents }] }`)
- `POST /icecream/days` `{ businessDate, salesCents, costAllocCents, electricityAllocCents (each 0–10^12), items?: [{ itemName, qty (1–10^6), unitPriceCents }] (≤ 200), confirmNegativeProfit?, notes?, clientRef }` → `201 { day, funds, warnings }`. The profit share S − C − E is computed by the server. A negative share without `confirmNegativeProfit: true` → `422 NEGATIVE_PROFIT_UNCONFIRMED`. Items must sum exactly to `salesCents` (`422 ITEMS_TOTAL_MISMATCH`). One posted entry per date: `409 DAY_EXISTS` (use `PUT`). Writes one `icecream_sale` cash entry per non-zero fund share (Cost C, Electricity E, Profit S − C − E) with matching fund entries.
- `PUT /icecream/days/:date` same body without `businessDate`, plus optional `reason` → `200 { day, funds, warnings }`. Void-and-replace, judged on the final state for the D2 guard (`422 VOID_BREAKS_RELEASE`); R-FD applies to the path date. Audit rows `void` (old) and `replace` (new). `404 NOT_FOUND` when there is no posted entry for the date.
- `POST /icecream/days/:date/void` `{ reason }` → `{ day, funds, warnings }`; `422 VOID_BREAKS_RELEASE` when profit already released depends on the entry ("profit already released depends on this entry — reverse the release first").
- `GET /icecream/days?from=&to=&status=&limit=&offset=` → `{ items, total, totals: { salesCents, costAllocCents, electricityAllocCents, profitShareCents } }`; `GET /icecream/days/:date` → `{ day }` (the posted entry only).

**Payments** (`IcePayment` = `{ id, businessDate, postedAt, backdated, kind, fund, amountCents, category|null, description, pnlTreatment: "settlement"|"expense", status, voidedAt, voidReason, clientRef }`)
- `POST /icecream/payments` `{ businessDate, kind: "materials"|"electricity_bill"|"other_cost", fund, amountCents (1–10^12), category?, description, clientRef }` → `201 { payment, funds, warnings }`. A `category` equal to "electricity" (trimmed, case-insensitive; "Electrical repair" is allowed) → `400 ELECTRICITY_NOT_ALLOWED` (use `kind: "electricity_bill"`). `pnlTreatment` is derived: `expense` only for `other_cost` paid from the Profit fund. Cash types `icecream_materials_payment`, `icecream_electricity_payment`, `icecream_other_cost`.
- `POST /icecream/payments/:id/void` `{ reason }` → `{ payment, funds, warnings }` (releases and payments only loosen the limits, so no guard).
- `GET /icecream/payments?from=&to=&kind=&fund=&status=` → `{ items, total, totals: { amountCents } }`.

**Fund moves** (`IceMove` = `{ id, businessDate, postedAt, backdated, fromFund, toFund, amountCents, kind: "release"|"reallocation"|"relabel", profitEffectCents, chargeRelabelCents, cashOnlyCents, note, status, voidedAt, voidReason, clientRef }`)
- `POST /icecream/fund-moves/preview` `{ fromFund, toFund, amountCents }` → `{ profitEligibleCents, cashOnlyCents, chargeRelabelCents, profitEffectCents, needsConfirmation, kind, explanation, warnings }`. No write. `400 SAME_FUND`.
- `POST /icecream/fund-moves` `{ businessDate, fromFund, toFund, amountCents, confirmSplit?, confirmedProfitEligibleCents?, note?, clientRef }` → `201 { move, funds, warnings }`. **D4:** a move into Profit above the profit-eligible limit is not posted unless the body has `confirmSplit: true` **and** `confirmedProfitEligibleCents` equal to the server's current eligible amount; otherwise `409 SPLIT_CONFIRMATION_REQUIRED` with `{ profitEligibleCents, cashOnlyCents, explanation }` (nothing posted; if the split changed meanwhile, the new split is returned again). One record then carries both parts. A move writes two fund entries and no cash entry.
- `POST /icecream/fund-moves/:id/void` `{ reason }` → `{ move, funds, warnings }`; `422 VOID_BREAKS_RELEASE` for re-allocations and Cost↔Electricity moves when the D2 guard fails; releases can always be voided.
- `GET /icecream/fund-moves?from=&to=&status=` → `{ items, total, totals: { amountCents, profitEffectCents, cashOnlyCents } }`.

**Funds and fund ledger**
- `GET /icecream/funds?asOf=&from=` → `FundsSummary`:
  `{ asOf|null, funds: { cost: { balanceCents }, electricity: { balanceCents }, profit: { balanceCents } }, totalCents, cashBookBalanceCents, reconciled, lines: { materials: { chargedCents, settledCents, unspentCents }, electricity: { … } }, unspentAllocationCents, outstandingExcessCostCents, recognizedProfitToDateCents, profitAfterExcessCostToDateCents, recognition: { dailyProfitShareCents, profitEligibleReleasesCents, reallocationsCents, otherExpensesCents, cashOverShortCents }, period: { from, to, recognizedProfitCents, excessCostNotChargedCents, profitAfterExcessCostCents }, warnings }`.
  Fund balances and recognized profit are separate figures (§10.1); `period` holds the three period-flow lines for `from..asOf` (§10.6); `warnings` may hold `NEGATIVE_FUND_BALANCE`, `EXCESS_COST_OUTSTANDING`, `ICECREAM_FUNDS_MISMATCH`. `from > asOf` is `400`.
- `GET /icecream/funds/entries?fund=&from=&to=&limit=&offset=` → `{ items: [{ id, businessDate, postedAt, fund, amountCents, kind, refTable, refId, reversesEntryId, note }], total, totals: { inCents, outCents, netCents } }` — the complete fund ledger including reversals.

All limits, splits and guards use posting order; reports use business dates. The pure calculation module is `services/icecream-rules.ts`.

---

## Reports

All reports are read-only (no audit rows) and are plain functions in `server/src/services/reports/` called by the routes and by the dashboard.

**Common query** for period reports: `from`, `to` (required business dates, inclusive, never rejected for being in the future; `from > to` or a range over 3,660 days is `400 VALIDATION_ERROR`), `granularity=day|month` (default `day`), `format=json|xlsx` (default `json`; `xlsx` returns the same figures as a workbook). JSON body: `{ from, to, granularity, rows: [{ period: { from, to, label }, …figures }], totals, table, warnings }` — reports that are not period-based document their own body but still include `table` and `warnings`; some add `extraTables`.
**Every row is calculated only from records whose business date lies inside that row's period** (BUSINESS_RULES §10.6): days add up to the month, months to the total, and the totals row equals the report over the whole range. Only `status = 'posted'` rows count; voided rows and reversal rows never appear in P&L figures (R1). Money is integer cents.

### Financial
- `GET /reports/pnl/shop`, `/reports/pnl/telecom`, `/reports/pnl/icecream`, `/reports/pnl/combined`.
  - **Shop** = goods revenue − cost of sales (automatic + extra cost, C13) + print revenue − print standard cost − Shop expenses − stock adjustments (net) ± cash over/short. **Telecom** = reload commission (base + extra) + EZCash commission + card revenue − card cost − Telecom expenses − stock adjustments ± cash over/short. Revenue lines are net of returns dated in the period. Collections, top-ups, printing supplies, drawings, capital, transfers and opening balances never appear.
  - **Stock adjustments (net)** = stock-loss rows of every source (manual and damaged-return) by business date and book + stocktake losses + residual sweeps − stocktake gains − **purchase refund gain** (R4: Σ purchase-return refunds by return date + Σ voided purchase totals by original date − value removed by `purchase_return`/`purchase_void` movements; exposed as `adjustments.purchaseRefundGainCents`, a positive number meaning gain, and as its own report column), with reversal rows netting out voids. The `loss` movement of a manual loss is not read (counted once). `personal_use` is not an adjustment.
  - **Ice Cream** returns the official recognized profit exactly as BUSINESS_RULES §10.6 (`salesCents`, materials and electricity charge lines, other expenses, cash over/short, `recognizedProfitCents`, `recognition`, `memo`, `excessCostNotChargedCents`, `profitAfterExcessCostCents`, `balancesAsOfPeriodEnd`, warning `EXCESS_COST_OUTSTANDING`). Balances are never summed; a totals row carries the value at `to`.
  - **Combined** = Shop + Telecom + Ice Cream recognized profit, each row with `segments.{shop,telecom,icecream}.recognizedProfitCents` and a top-level `recognizedProfitCents`, plus the informational electricity line (E5: electricity charged in the period and bills paid, never added or deducted) and the excess-cost lines.
- `GET /reports/cashbook/:book` — per period: opening, in, out, closing, per entry-type totals (`typeTable`), per fund for Ice Cream (`fundTable`), `ledgerBalanceAsOfToCents`. A cash book's in and out include the opposite rows of voided records (a voided transfer appears in both books' in and out; the net stays zero).
- `GET /reports/transfers` — posted transfers with totals by direction (`itemsTable`).
- `GET /reports/icecream-funds` — per fund per period: opening, allocations, opening/capital/transfers in, moves (profit-eligible and cash-only split), payments, drawings and transfers out, over/short, closing; total equals the Ice Cream cash book; recognized profit and excess-cost block (`profitTable`) kept separate from balances.

### Operational
- `GET /reports/inventory/valuation?asOf=&book=&categoryId=&includeZero=&includeInactive=` — always from the movement sum up to `asOf` (equals the cache for today; a past date shows `matchesCache: null`); warning `NEGATIVE_STOCK_AS_OF` when a backdated sale leaves an earlier date negative.
- `GET /reports/stock-movements?from=&to=&productId=&type=&book=&limit=&offset=`
- `GET /reports/stock-losses?from=&to=&granularity=&book=` — by reason, product, book.
- `GET /reports/product-profitability?from=&to=&book=&categoryId=` — net quantity sold, revenue, cost incl. extra, gross profit, margin (bp), after returns.
- `GET /reports/low-stock?book=&categoryId=&includeInactive=` — active stock products with `reorderLevel > 0` and quantity at or below it (equal counts; a level of 0 means "not set").
- `GET /reports/purchases?from=&to=&granularity=&book=&supplierId=` — net of purchase returns.
- `GET /reports/sales?from=&to=&granularity=&book=&topN=` — revenue net of returns (gross and returns shown separately), cost, gross profit, sale counts, top products.
- `GET /reports/drawings?from=&to=&granularity=&book=` — cash and goods drawings; capital counts only `kind = 'capital'`; transfers and opening balances are memo lines outside the totals.
- `GET /reports/printing-variance?from=&to=&granularity=` — standard cost charged (Σ print sale cost) vs supplies spent; difference = spent − charged; revenue and gross profit by service type. Supplies never enter gross profit.
- `GET /reports/backdated?from=&to=&book=&limit=&offset=` — records whose business date is earlier than the Colombo date of their posting time (`business_date < date(posted_at,'+330 minutes')`), 21 record types, voided records included with `status = 'void'`; `from`/`to` filter on business date.

---

## Dashboard and export pack

- `GET /dashboard?asOf=` (business date, default today; past and future dates accepted; bad date or unknown parameter is 400). Runs in one transaction. Response:
  `{ asOf, today: { salesCents, profitCents, bySegment: { shop, telecom, icecream } }, month: { same, 1st of asOf's month .. asOf }, cash: { books: [{ book, balanceCents, funds?, fundsMatchBook? }], totalCents }, stock: { valueCents, lowStockCount, lowStock: [top 10 { productId, name, qty, reorderLevel }], negativeOrWarning }, icecream: { recognizedProfitMonthCents, funds: { cost, electricity, profit }, fundsTotalCents, fundsMatchBook, excessCostNotChargedTodayCents, excessCostNotChargedMonthCents, profitAfterExcessCostMonthCents, outstandingExcessCostCents, warnings }, closings: { lastClosedByBook, openDaysBehind }, backup: { latestAt, ageHours, status: "ok"|"stale"|"none" }, series: { daily (last 30 days to asOf), monthly (asOf's month and the 11 before), topProducts (top 5 by gross profit this month) }, warnings, definitions }`.
  - "Sales" per segment: Shop = goods + print revenue net of returns; Telecom = scratch-card revenue + reload commission + EZCash commission (collections and top-ups are cash only); Ice Cream = daily sales; Combined = the sum. Profit = the Phase 11 segment net profit; Ice Cream profit is the recognized profit, with fund balances kept separate.
  - `openDaysBehind`: per book, dates in the 7 days before `asOf` not yet closed, only on or after the book's first cash entry. `backup.status` is `stale` after 48 hours (real clock) and `none` without a backup. The `definitions` block spells these out in plain language.
  - Every figure equals the matching report for the same range (tested).
- `GET /reports/export-pack?from=&to=` → one `.xlsx` of 15 sheets: Combined P&L (by month), Shop P&L, Telecom P&L, Ice Cream P&L, Ice Cream funds, Ice Cream profit and excess, Cash book - Shop, Cash book - Telecom, Cash book - Ice Cream, Inventory valuation (as of `to`), Low stock, Sales, Purchases, Drawings, Printing variance. `from > to` or a range over 3,660 days is `400`.

---

## Internal module signatures

For developers. Relative imports in `server/` include the `.ts` extension; only erasable TypeScript syntax is used (no `enum`, `namespace` or parameter properties).

**`db/db.ts`** `AppDatabase(filePath)` opens the file with `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=FULL`. `conn` (throws `DB_CLOSED` when closed), `isOpen`, `tx(fn)` (outermost call `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`, nested calls use savepoints, async functions are refused), `close()` (checkpoints the WAL; idempotent), `reopen()`. `openDatabase(path)` is the raw open.

**`db/migrate.ts`** `loadMigrations(dir?)` (file names `^\d{3}_[a-z0-9_]+\.sql$`, duplicate versions throw), `checksumOf(sql)` (SHA-256 of the CRLF-normalised text), `currentVersion(conn)`, `latestVersion(dir?)`, `migrate(conn, dir?)` (applied checksum mismatch → `MIGRATION_CHECKSUM_MISMATCH`; database newer than the program → `MIGRATION_DB_TOO_NEW`; each file in its own transaction), `REQUIRED_TABLES = ['schema_migrations','settings','audit_logs']`.

**`lib/money.ts`** `isCents`, `mulDivRound(a, b, c)` (exact BigInt, half away from zero, safe integers only, throws `RangeError` otherwise), `applyBp(cents, bp)`, `rupeesToCents("1,320.50") = 132050` (more than 2 decimals or junk throws), `formatLKR(1234567) = "Rs. 12,345.67"` (negative `-Rs. 1,234.50`).
**`lib/dates.ts`** `BUSINESS_TZ = 'Asia/Colombo'`, `todayBusinessDate(now?)`, `isIsoDate(s)` (strict and a real calendar date), `nowIso()`, `backupStamp(now?)`.
**`lib/errors.ts`** `AppError(statusCode, code, message, fields?, extra?)`.
**`lib/report-table.ts`** `ReportTable`, `listPeriods`, `daysInRange`, `reportTablesToXlsx`, `MAX_REPORT_DAYS = 3660`.

**`app.ts`** `buildApp({ dataDir, webDistDir?, logger? })` creates `<dataDir>/backups`, opens `<dataDir>/viman.db`, migrates, registers every route under `/api/v1`, serves `webDistDir` when it holds `index.html`, and returns `{ app, ctx }` where `ctx = { database, dataDir, backupsDir, dbPath, appVersion, isRestoring }`. It does not take the start-up backup (`index.ts` does), so tests control backups.

**Services** (`server/src/services/`): `inventory.service.ts` is the only writer of stock movements — `receiveStock`, `issueStock` (weighted average; `INSUFFICIENT_STOCK` above the pool), `issueStockCapped` (R4 purchase return/void), `reverseMovements` (exact negation), `gainValue` (C10), `poolsAsOf`, `reconcileStock`. `cash-posting.ts` (`postCash`, `reverseCash`) writes a cash entry and, for Ice Cream, its fund entry. `day-closing.ts` (`assertDayOpen`), `cash-warnings.ts`, `audit.service.ts` (`logAudit`, called inside the caller's transaction), `validation.ts` (`checkBusinessDate`, `futureDateError`, `trimmed`, ...), `icecream-rules.ts` (pure §10 logic). Repositories in `server/src/repositories/` take the connection first, contain SQL only and map snake_case to camelCase.

## Category management and category-first selection (contract, 2026-11-13)
Owner request: categories managed in the app; products chosen category-first. **No accounting behaviour changes.** One category system only (`categories` + `products.category_id`).
**Database (migration `015_category_per_book.sql`, forward-only, never edits 001–014):** rebuild `categories` so the name is unique **per book, case-insensitively** (`UNIQUE INDEX ux_categories_book_name ON categories(book, name COLLATE NOCASE)`) instead of globally; ids, `is_default`, `active`, timestamps and every `products.category_id` link preserved exactly (`PRAGMA defer_foreign_keys = ON`, copy with ids, drop, rename, recreate the migration-003 triggers `trg_categories_default_locked` and `trg_categories_book_has_products`, then verify `PRAGMA foreign_key_check` is empty); add `BEFORE DELETE ON categories` guard `CATEGORY_DELETE_FORBIDDEN` (categories are retired by deactivation, never deleted). Rollback note for the migrations README: forward-only; to undo, restore a backup made at start-up before 015 ran (the app takes one automatically).
**API changes (all additive):**
- `POST /categories` and `PUT /categories/:id`: duplicate check is `(book, name)` case-insensitive → `409 DUPLICATE_NAME` message "A <Shop|Telecom> category with this name already exists." (`fields.name`). The same name in the other book is allowed. Changing `book` is allowed only for a non-default category with no products and must not collide in the target book. Default categories keep their locked name/book (`409 DEFAULT_CATEGORY_LOCKED`); they can be deactivated/reactivated. Names are trimmed, 1–60 characters. `GET /categories` already returns `productCount`, `createdAt`, `updatedAt`, `isDefault`, `active`.
- `POST /products` accepts **either** `categoryId` **or** `newCategory: { name, book }` (exactly one; neither/both → 400 `VALIDATION_ERROR` on `categoryId`). With `newCategory` the category is created in the **same transaction** as the product (same duplicate rules; if a category with that name already exists in that book and is active the request fails `409 DUPLICATE_NAME` with `existingCategoryId` in the error body so the UI can offer to use it; an inactive one → `409 CATEGORY_INACTIVE`-style message to reactivate it first). The product's book is always its category's book. Audit rows for both creates.
- `GET /products` gains `kind=stock|service` (additive; existing filters `q, categoryId, book, active, lowStock, limit, offset` unchanged).
- `POST /excel/opening-stock/preview` rows gain `categoryName` and `book` (additive; import logic untouched).
**Shared web picker (`web/src/components/CategoryProductPicker.tsx`, owned by the shared-UI agent):** props `{ book: Book | null; value: Product | null; onChange(p: Product | null): void; categoryId: number | null; onCategoryChange(id: number | null): void; requireCategory?: boolean; excludeProductIds?: number[]; stockOnly?: boolean (default true); onCreateProduct?(ctx: { book: Book | null; categoryId: number | null }): void; disabled?: boolean }`. Behaviour: category select lists **active** categories of `book` (both books with a Shop/Telecom tag when `book` is null); choosing/changing a category **clears the selected product** (`onChange(null)`); the product dropdown shows only **active** products of that category (server filtered: `categoryId`, `active=true`, `kind=stock`, `q`), with a search box inside it; `requireCategory` true → products disabled until a category is chosen (purchases, opening stock), false → an "All categories" option (POS keeps its fast search/scan); empty category → helpful empty state with the "New product" action when `onCreateProduct` is given; never lists products of another book than `book`. No accounting logic.
**Ownership.** Backend agent: migration 015, `catalog.service.ts`, `categories.repo.ts`, `products.repo.ts`/routes for the changes above, `opening-stock` preview rows, backend tests. Shared-UI agent: `CategoryProductPicker.tsx`, `pages/products/*` (Category management tab, product dialog with Shop/Telecom → category → "create new category"), `api/catalog.ts`, `types/api.ts` additions. Screen agents (after the shared UI is merged): POS + stock screens; Purchases + Opening Stock.

### Category management — as built (2026-11-13)
Supersedes the contract text above where it differs. `POST/PUT /categories`: duplicate check per (book, name), case-insensitive after trimming → `409 DUPLICATE_NAME` ("A Shop category with this name already exists.", in `message` and `fields.name`); same name in the other book allowed; a rename plus book move in one request is checked in the target book; default categories → `409 DEFAULT_CATEGORY_LOCKED` for name/book changes (they can be deactivated/reactivated); book change with products → `409 CATEGORY_HAS_PRODUCTS` (checked before the duplicate check). `POST /products`: exactly one of `categoryId` or `newCategory: { name, book }` (neither/both → 400 `VALIDATION_ERROR` on `categoryId`); `newCategory` creates the category and the product in one transaction (audit rows for both; a product failure such as a duplicate name rolls the category back); an active same-name category in that book → `409 DUPLICATE_NAME` with `existingCategoryId`; an inactive one → `409 CATEGORY_INACTIVE` with `existingCategoryId` ("This category exists but is inactive. Reactivate it first."). `GET /products?kind=stock|service` (bad value → 400). Opening-stock preview rows (and the 422 `IMPORT_HAS_ERRORS` row list) carry `categoryName` and `book` (null for unknown or service SKUs). A race on the unique index maps to "A category with this name already exists in that book." Web: Products → Categories (name, book, number of products, status, created date, Edit name, Activate/Deactivate, no delete); product dialog (1 book, 2 category or "+ Create new category", 3 details); shared `CategoryProductPicker` (Purchases, Opening Stock manual entry); POS category-first panel (book filter, category selector with "All categories", search inside the list, Enter/scanner still adds, exact code match falls back to all categories); stock-loss and personal-use dialogs use a local category-first picker that still lists inactive products (§13A decision 6); Purchases: bill book first, picker per line, "New product" from the line (book locked, category pre-selected, duplicate-name hint with "Use the existing product"), changing the book with lines asks for confirmation.

## Approved-decisions contract (2026-11-13): closed-day ordering, void sales return, external backups
Rules: BUSINESS_RULES §4 R-VR, §8 closed-day ordering, §12 external backups, §13A. **No approved accounting formula changes.** Migrations: **016** closed-day ordering (trigger), **017** void sales return, **018** external backups. Numbers are fixed per workstream; the runner has no gap rule.

**A. Closed-day ordering protection (migration 016; agent C).** One shared check in `services/day-closing.ts` (`assertDayOpen` or a sibling it calls) used by every write: for every book the write touches, if the entry's business date is **earlier than the latest currently-closed day** of that book → `409 BACKDATE_BEFORE_CLOSED_DAY`, message "A later day (<closedDate>) is already closed for the <Shop|Telecom|Ice Cream> cash book. Entries dated before it would change a closed day. Reopen that day first, or use a date after it.", `error.book`, `error.closedDate`, `error.businessDate`. A write dated exactly on a closed day stays `DAY_CLOSED`. Applies to creates, voids (judged on the record's/return's business date, since the reversal copies it) and returns, in every service that already calls `assertDayOpen` (purchases, sales, returns, losses, stocktake completion, drawings, opening stock, telecom, printing, expenses, opening balance, cash counts/closings with a cash adjustment, transfers (both books), capital, Ice Cream records). Validation order stays: schema → R-FD → lookups/R-RD → closed-day checks → business rules. Database backstop: migration 016 replaces `trg_cash_entries_day_closed` (older migrations are never edited: DROP TRIGGER + CREATE TRIGGER in the new file) so a cash entry dated before the latest closed day of its book aborts `BACKDATE_BEFORE_CLOSED_DAY`, and extends the Ice Cream record day-closed triggers the same way; closing a day without a count posts nothing and stays allowed. Existing tests that deliberately wrote entries earlier than an already-closed day must be adjusted only where the new rule is the cause, each justified.

**B. Void sales return (migration 017; agent R).** `POST /sales/:saleId/returns/:returnId/void` `{ reason }` → `200 { item: SaleReturn, sale: Sale, warnings }` (`SaleReturn` gains `status: 'posted'|'void'`, `voidedAt`, `voidReason`; `GET /sales/:id` lists returns with status; each line's `returnedQty` reflects posted returns only; refund totals in lists count posted returns only). Errors: `404 NOT_FOUND` (sale or return), `409 ALREADY_VOID`, `409 RETURN_NOT_NEWEST` (`error.newerReturnId`), `409 RETURN_STOCK_NOT_AVAILABLE` (`error.productId`, `onHand`, `needed`), `409 DAY_CLOSED`, `409 BACKDATE_BEFORE_CLOSED_DAY`. Rules R-VR 1–9 in BUSINESS_RULES §4 are normative. Schema (the agent designs it; constraints must be at least as strong as today): status/voided_at/void_reason on `sales_returns` with a consistency CHECK; return rows otherwise immutable (only posted → void); returned-quantity invariant `sale_items.returned_qty = Σ qty of POSTED return items` enforced by trigger (a decrease is allowed only as part of a void); the linked damaged-return `stock_losses` row voidable only through the return void (the existing `DAMAGED_RETURN_LOSS` guard stays for direct voids); reversal stock movements and the reversal cash entry follow the existing reversal conventions (new rows with `reverses_*` links, original business date, unique link so a double void is impossible); append-only ledgers untouched. Reports: every query that reads `sales_returns`/`sales_return_items` (financial P&L, sales report, profitability, dashboard, cash/stock reports, sales list totals) must read **posted** returns only; the stock-value difference of R-VR 3 (restored value − value removed) is a negative stock-adjustment component in the Shop/Telecom P&L (new `adjustments.salesReturnVoidGainCents`, positive = gain, own report column, included in `netCents`) so the profit identity (P&L = cash + stock) closes exactly. Audit: action `void` on entity `sales_return` with business date and backdated flag. Web: a "Void return" action with a confirmation dialog explaining the consequences, on each return in the sale detail (disabled with the reason shown when it is not the newest); results through the existing cash-warning toast.

**C. External backups (migration 018; agent B).** Tables: `backup_settings` (single row: `external_dir`, `updated_at`) and append-only `external_backup_log` (`id, source_name, target_name, status 'ok'|'failed'|'skipped', size_bytes, sha256, error, created_at`); the existing `settings` table keys are CHECK-restricted and are not used. Endpoints: `GET /backups/external` → `{ configured, folder, folderAvailable, writable, lastSuccessAt, lastAttemptAt, lastError, daysSinceSuccess, status: 'ok'|'not_configured'|'drive_missing'|'failed'|'stale', warning: string|null, copies: [{ name, sizeBytes, createdAt }] }` (newest first, max 30); `PUT /backups/external` `{ folder: string | null }` (null clears; invalid → 400 `EXTERNAL_FOLDER_INVALID` with a plain message: must be an absolute local path, existing and writable, not inside the data folder, **not inside a cloud-synced folder** — any path segment equal (case-insensitive) to or starting with `OneDrive`, `Google Drive`, `GoogleDrive`, `Dropbox`, `iCloud`, `Box`, `pCloud`, `MEGA`, and UNC paths are refused with `EXTERNAL_FOLDER_CLOUD`); audited; `POST /backups/external/copy` → `{ copied: [{ name, sizeBytes, sha256 }], skipped: [{ name, reason }], failed: [{ name, error }], status }` copying every start-up/manual backup not yet present externally (newest first). Copy rules: write to a temporary name in the target folder, flush, verify size **and SHA-256** against the source, then rename to the final name; **never overwrite** (an existing identical file → skipped `already_present`; an existing different file → written under a new unique name, never replaced); after copying, prune only files in the folder matching `^viman-\d{8}-\d{6}-(startup|manual)(-\d+)?\.db$`, keeping the newest 30; a missing, unwritable or full drive records a `failed` log row and returns a warning and **never throws into normal operation**. Automatic: after the start-up backup and after each manual backup (non-blocking, errors logged) and by a low-frequency timer (every 10 minutes, `unref`'d) that copies when the folder becomes available. The dashboard `backup` block gains `external: { status, lastSuccessAt, daysSinceSuccess, warning }` and a top-level warning when the status is `stale` (configured, no successful copy for 7 days or more), `drive_missing` or `failed`; `not_configured` shows an informational amber note. Web: Settings → Backups gets the external-folder field with Save, a **Copy backup now** button, the status, last copy, warnings and the list of external copies; the dashboard backup card shows the external status.

**D. Small UI items (agent U, web only).** (1) Deactivating a product that still has stock (`qtyOnHand > 0`) asks for confirmation ("<n> units are still in stock; they stay valued but cannot be sold or purchased until you reactivate the product") and proceeds after confirmation. (2) The Printing screen/menu is renamed **Services** (route `/services`; `/printing` redirects), tabs "Print & service sales", "Service types", "Supplies"; the service-type dialog text explains that any service can be added; printing behaviour untouched. (3) The product dialog no longer offers the Service kind when **creating** a product (editing an existing service product keeps showing it). (4) `components/BackdatedNotice.tsx` (provided by the orchestrator) is shown beside the business-date field on every inventory-transaction form. (5) Stocktake screen hint: "Complete the stocktake immediately after counting, when the shop is quiet."

### Approved-decisions — as built (2026-11-13)
- **Closed-day ordering:** the service check names the book, closed date and entry date; the database trigger backstop answers the same code with a generic message (it cannot carry dates). A closing or count whose adjustment would post a cash entry earlier than a closed day is refused; closing without a count, or with a zero difference, stays allowed. If one touched book has the exact day closed, `DAY_CLOSED` wins over a backdate refusal in another book.
- **Void sales return:** `POST /sales/:id/returns/:returnId/void` as in the contract. `RETURN_NOT_NEWEST` names the newest blocking return in `newerReturnId`. The audit entity is `sale_return` (the same entity as the create row, so one return's history stays together; the contract text said `sales_return`). Reversal stock movements reuse movement type `sale_return` with negative quantity/value (the existing "same type, negated" convention); the residual sweep is the value-only `adjustment`. The stock-value difference is `adjustments.salesReturnVoidGainCents` in Shop/Telecom P&L (positive = gain, own column, included in `netCents`, landing in the return's period; also in the stock-losses memo).
- **External backups:** UNC paths answer `EXTERNAL_FOLDER_CLOUD` (per the contract); `POST /backups/external/copy` with no folder set → `409 EXTERNAL_FOLDER_NOT_SET`; drive problems answer 200 with `failed`, `status` and `warning`; a different file already under the same name is copied as `-2`, `-3`, ...; a source that would be pruned immediately is skipped `older_than_retention`; stale `.viman-copy-*.tmp` files older than one hour are removed; status precedence: stale over drive_missing over failed; the folder setting lives in the database, so restoring an older backup restores its folder setting too; pre-restore safety copies stay local. Dashboard warnings: `EXTERNAL_BACKUP_STALE`, `EXTERNAL_BACKUP_DRIVE_MISSING`, `EXTERNAL_BACKUP_FAILED`.

## Hardening contract (owner-approved 2026-11-13; findings M1–M7 of AUDIT_REPORT_2026-11-13.md)
**No approved accounting rule or formula changes. Historical records are never altered. Forward-only migrations (old ones are never edited). Append-only ledgers and the existing reversal behaviour are preserved. No constraint is weakened; no test is removed or reduced.** The failing reproductions of the findings live on branch `origin/audit/defect-reproductions` (files `phase19-closedday-db`-style characterisation tests are already in main; the seven `*-defect-*.test.ts` files are only on that branch): agents take them as the starting point and make them PASS without weakening their assertions. Characterisation tests in main that assert today's gap (for example raw inserts accepted before a closed day) must be updated to assert the new refusal, each change justified in the agent's report.
Migration numbers (fixed per workstream; the runner has no gap rule): **019** M1, **020** M2–M4, **021** M5–M6. M7 needs no migration.

**M1 — closed-day protection in the database (migration 019).** The database enforces exactly the application rule (BUSINESS_RULES §8; `day-closing.ts`): for every book a row touches, a business date **on** a closed day → abort `DAY_CLOSED`; a date **earlier than the latest currently-closed day** of that book → abort `BACKDATE_BEFORE_CLOSED_DAY` (closed = `reopened_at IS NULL OR closed_at > reopened_at`). Add BEFORE INSERT triggers (and BEFORE UPDATE OF status for void flips of records whose void would change a closed period) on every table that can carry a business date in a closed period and is not yet protected: `stock_movements` (book = the product's book), `stock_losses`, `stocktakes` (judged when completed), `owner_drawings`, `opening_stock_batches`, `sales`, `sales_returns`, `purchases`, `purchase_returns`, `expenses`, `capital_entries`, `cash_counts` (only when it has an adjustment/for non-zero difference; zero-difference counts: exact day only), `reload_sales`, `ezcash_sales`, `telecom_topups`, `print_sales`, `printing_supplies`, `cash_transfers` (both books), `icecream_fund_entries` (book icecream), `icecream_sales` (child lines of a day), `icecream_payments` void flip (migration 016 added none), and any other business-date table found by reading `sqlite_master` (agent lists them). Rules: reversal rows copy the original date and follow the same rule; the closing operation's own writes (count adjustment dated on the day being closed, before the closing row exists) must keep working; draft stocktakes and other non-posting rows stay allowed; the service layer is unchanged and still answers first with its friendly message; the trigger abort codes map to the same 409 codes wherever aborts are mapped. Direct-SQL tests must show that no raw INSERT / void flip can bypass the rule for every protected table and that a legitimate flow still works.

**M2 — void status protection (migration 020).** `posted → void` is the only allowed transition and `void` is terminal (already enforced on most tables; verify all). Add, for every document table with cash and/or stock effects (list them from the code: sales, sales_returns, purchases, purchase_returns, stock_losses, stocktakes, owner_drawings, opening_stock_batches, expenses, capital_entries, cash_counts, reload_sales, ezcash_sales, telecom_topups, print_sales, printing_supplies, cash_transfers, icecream_days, icecream_payments, icecream_fund_moves, …), a BEFORE UPDATE OF status trigger that aborts `VOID_WITHOUT_REVERSAL` unless the required reversal rows already exist: every original non-zero cash entry of the record (`ref_table`, `ref_id`, `reverses_entry_id IS NULL`) has exactly one reversal entry (`reverses_entry_id` = original, opposite amount, same book/fund/date) and every original stock movement of the record has its reversal movement(s) recorded (the agent decides the linkage from the schema; stock_movements has no reverses column today — a forward-only migration may add a nullable `reverses_movement_id` to NEW rows only, with a unique index, without touching old rows, or the agent may use ref + type + sign rules; whichever is chosen must be exact enough to refuse a flip with missing reversals) and Ice Cream fund rows are reversed too. This requires the void services to write the reversal rows **before** flipping the status: re-order every void path accordingly (and re-create the migration-017 return triggers `RETURN_NOT_VOID`/newest-first/cascade so they work with reversal-first order, via DROP + CREATE in migration 020), keeping all existing behaviour, error codes, validation order and tests. Records without cash/stock effects (for example a zero-total sale, a draft stocktake) are exempt. A raw `UPDATE … SET status='void'` without the reversal rows must be refused for every table; legitimate voids must work unchanged.

**M3 — stock reversal protection (migration 020).** Reversal stock movements of a void return are bounded in quantity **and value**: a `sale_return` reversal row must have `qty_delta < 0` (value-only reversals refused), and the value removed per return and product may not exceed the value restored; at most **one** residual sweep (`adjustment`) per void return and product; every reversal row links to its return (`ref_table/ref_id`) and can exist only once (unique link). Σ movements = cache is preserved.

**M4 — duplicate return effects (migration 020).** One refund cash entry per return (`ref_table='sales_returns'`, `reverses_entry_id IS NULL`) — partial unique index; restock movements per return and product bounded by the quantities of that return's items (trigger); a second refund/restock for the same return is refused by the database (concurrent attempts included: unique indexes). Existing void-return accounting and newest-first rules unchanged.

**M5 — external backup status (migration 021 + services).** Distinct, accurate states: `ok` (folder available and every start-up/manual backup is present and verified externally — "synchronized", including when nothing new had to be copied), `not_configured`, `drive_missing`, `failed` (the latest run failed to copy), `stale` (**only** when synchronization could not be confirmed for ≥ 7 days: i.e. no run found the folder available and fully synchronized in the last 7 days). A run that finds the folder available and every backup already present (identical size/SHA-256 or an equivalent verified clean name) counts as a **successful synchronization** and updates `last_sync_at` even though no new file was written; "Copy backup now" therefore clears a stale warning whenever the drive is fine. No false warning when synchronized. Status per **folder**: after the folder setting changes the status reflects the new folder (not the last success of any folder); setting a folder triggers an immediate non-blocking sync. Dashboard/Settings text distinguishes "Synchronized", "Not set up", "Drive not found", "Last copy failed", "Overdue (no confirmed sync for N days)".

**M6 — bounded failure log (migration 021 + services).** Add a small mutable state table `external_backup_state` (single row per folder or global: last_attempt_at, last_success_at, last_sync_at, consecutive_failures, last_error_code, last_error_message, first_failure_at, last_failure_logged_at) updated by every run; `external_backup_log` (append-only) receives a row **only on a state change** (first failure of an error kind, recovery, a successful copy of a file) and at most one failed row per (error kind, source file) per 24 hours; repeated identical failures only increment the counter in the state table (and the Settings page shows "failed N times since …"). The log can therefore not grow without bound while a drive stays full, read-only or missing; useful diagnostics (first and last occurrence, count, last error) are kept. The append-only guards on the log stay.

**M7 — restore validation (no migration).** Before the live database is touched, validate the candidate backup (upload or named) against ALL of: full SQLite `PRAGMA integrity_check`; `PRAGMA foreign_key_check` (must be empty); schema version known and not newer than the program; migration records consistent (versions 1..N present, checksums equal to the program's migration files for those versions); required tables, indexes and triggers for its schema version present (compare names with a reference database built by applying that version's migrations to an empty database — report each missing/unexpected object); after a trial upgrade to the current version on a temporary COPY (so migrations are proven to run), the database invariants: per product stock cache = Σ movements (qty and value) and no negative stock; per cash book balance consistent with its ledger (reversal entries negate their originals, none reversed twice); Ice Cream Cost+Electricity+Profit = Ice Cream cash book = Σ fund ledger; `sale_items.returned_qty` = Σ posted return quantities; every voided record has its reversal rows (same rule as M2); no business date in the future; append-only/unique structures intact. Implement as one reusable module `services/database-validation.ts` (pure, takes a connection, returns a list of failed checks with plain-language messages) used by restore. On failure: refuse with `422 RESTORE_INVALID` listing the failed checks (max 10 shown + total count) in plain words; **the live database is not replaced or modified**; the pre-restore safety backup (if already made) is kept and no temporary file remains; the refusal is recorded in the audit log of the LIVE database (entity `backup`, action `restore_refused`, reasons) where safe (never if it could fail the request); a valid backup (including a valid external copy and an older-schema backup) still restores successfully, and restore remains atomic with rollback on failure. Existing restore tests keep passing; characterisation tests that accepted flipped-byte files are updated to the new behaviour (refuse when integrity/FK/schema/reconciliation fails; the report states honestly that a change inside free-text columns is undetectable).

**Ownership.** H1: migration 019 + trigger tests (+ the characterisation tests of closed-day DB protection). H2: migration 020 + all void services' ordering + M2–M4 tests. H3: migration 021 + `external-backup*.ts` + external routes/UI text (Settings, dashboard). H4: `services/database-validation.ts` + the restore flow in `backup.service.ts` + restore route/UI text. Shared: `routes/backups.ts` is edited by H3 (external section only) and H4 (restore section only).
