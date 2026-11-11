# API Contracts

Base path: `/api/v1`. JSON in/out (UTF-8). Money fields end in `Cents` and are **integers**. Rates end in `Bp` (basis points, 600 = 6.00%). Dates `YYYY-MM-DD`; timestamps ISO-8601 UTC strings. Field names are camelCase in JSON, snake_case in SQL.

## Conventions
- **Errors**: any non-2xx response body is
  `{ "error": { "code": "UPPER_SNAKE", "message": "Human readable", "fields": { "<path>": "message" } } }` (`fields` optional).
  - Request validation failures → `400 VALIDATION_ERROR` with `fields` keyed by JSON path (e.g. `"shop.name"`, `"rates.reloadCommissionBp"`).
  - Unknown route under `/api` → `404 NOT_FOUND` (JSON, never the SPA HTML).
  - Unexpected → `500 INTERNAL_ERROR` (message generic; details only in server log).
- **Idempotency** (from Phase 2+): every create of a financial record accepts `clientRef` (UUID from the browser). A repeat with the same `clientRef` returns the original record with `200` instead of creating a duplicate.
- **Validation** uses Fastify's native JSON Schema (`additionalProperties: false` on bodies). **No type coercion**: a money/rate field sent as `null` or `"600"` is a 400, never silently converted. Numeric query-string params are digit strings validated in the route.
- **Business date vs posting time** (Phase 2+): every financial record in any response carries `businessDate` (owner-entered) and `postedAt` (server timestamp, read-only, never accepted in a request body) plus `backdated: boolean`. Reports group by `businessDate`; posting-order rules (Ice Cream limits, D4, D2, costing) use `postedAt`. `asOf`, `from`, `to` query parameters are business dates. Reversal rows carry the business date of the row they reverse. From Phase 3, `GET /audit-logs` items add `postedAt` (= `at`), `businessDate` (null for non-financial entries) and `backdated`.
- **Future-dated transactions** (R-FD, Phase 2+): every financial write whose body contains a business date (`businessDate`, or the date field of that record) is validated **on the server**: a date later than today in Asia/Colombo → `400 FUTURE_DATE_NOT_ALLOWED` with `message: "Future-dated transactions are not allowed. Please select today or an earlier date."` and `fields: { businessDate: "Future-dated transactions are not allowed. Please select today or an earlier date." }` (field name = the request's date field). Applies to all P2–P13 write endpoints that create financial records (sales, sales returns, purchases, purchase returns, opening stock, stocktakes, losses, drawings, reloads, EZCash, top-ups, printing supplies, expenses, opening balances, capital, transfers, cash counts, daily closings, Ice Cream days/payments/fund moves — incl. the replacement row of `PUT /icecream/days/:date` — and opening-stock import rows). Earlier dates are accepted. `postedAt` is read-only: a request body containing `postedAt` → `400 VALIDATION_ERROR` with `fields.postedAt` (`additionalProperties: false`). The web date pickers use `max = today` (from `GET /health` `today`), but the server is authoritative. **Validation order:** JSON schema → R-FD → (returns only: original lookup `404 NOT_FOUND`, then R-RD) → `DAY_CLOSED` → `SPLIT_CONFIRMATION_REQUIRED` / void guards / other business rules. **Scope:** report and query dates (`asOf`, `from`, `to`) are never rejected. Write paths always call `todayBusinessDate()` without an injected clock (the database trigger uses the real clock); tests fake time only for read/report logic.
- **Return date** (R-RD, Phase 3/5): `POST /sales/:id/returns` and `POST /purchases/:id/returns` with a `businessDate` earlier than the original sale's / purchase's business date → `400 RETURN_BEFORE_ORIGINAL_DATE` with `message: "The return date cannot be earlier than the original sale date (2026-11-05). Please select 2026-11-05 or a later date (not after today)."` (`purchase` for purchase returns; the date is the original's business date), `fields: { businessDate: <same message> }` and `originalDate: "YYYY-MM-DD"` in the error body. On-or-after dates (incl. backdated) are accepted, subject to R-FD. The web return form sets the date picker range to *original date … today*, but the server is authoritative. **Validation order** for returns: JSON schema → R-FD (`FUTURE_DATE_NOT_ALLOWED`) → original lookup (`404 NOT_FOUND`) → R-RD (`RETURN_BEFORE_ORIGINAL_DATE`) → `DAY_CLOSED` (judged on the **return's** business date) → quantity/void/business rules. The original date is returned as `error.originalDate`.
- While a restore is running every other `/api` request gets `503 RESTORE_IN_PROGRESS`.

---

## Phase 1 endpoints (implemented in Phase 1)

### `GET /api/v1/health`
`200`
```json
{ "status": "ok", "appVersion": "0.1.0", "schemaVersion": 2, "time": "2026-11-10T06:00:00.000Z", "today": "2026-11-10" }
```
`today` is the business date in Asia/Colombo.

### `GET /api/v1/settings`
`200`
```json
{
  "shop": { "name": "Viman Mobile", "address": "162 Padiliyathuduwa Rd, Hunupitiya, Wattala", "phone": "+94 71 900 4044", "email": "viman.mobile.shop@gmail.com" },
  "rates": { "reloadCommissionBp": 600, "ezcashCommissionBp": 80 },
  "printDefaults": [
    { "code": "BW_1S",   "name": "B/W print – one side",       "priceCents": 1500, "costCents": 650 },
    { "code": "BW_2S",   "name": "B/W print – double side",    "priceCents": 2500, "costCents": 900 },
    { "code": "CLR_1S",  "name": "Colour print – one side",    "priceCents": 2000, "costCents": 650 },
    { "code": "CLR_2S",  "name": "Colour print – double side", "priceCents": 3000, "costCents": 900 },
    { "code": "PC_BW_1S","name": "Photocopy B/W – one side",   "priceCents": 1000, "costCents": 650 },
    { "code": "PC_BW_2S","name": "Photocopy B/W – double side","priceCents": 1500, "costCents": 900 },
    { "code": "CUSTOM",  "name": "Custom image print",         "priceCents": 4000, "costCents": 650 }
  ],
  "updatedAt": "2026-11-10T06:00:00.000Z"
}
```
`updatedAt` = latest `updated_at` across settings rows (null if never updated). The values above are the **defaults** seeded when no row exists. `printDefaults` are stored now and used in Phase 7 to seed print service types.

### `PUT /api/v1/settings`
Body: any subset of the three sections; each section present **replaces that section entirely**.
```json
{ "shop": {...}, "rates": {...}, "printDefaults": [...] }
```
Validation:
- `shop.name` 1–100 chars (trimmed, required when `shop` given); `address` 0–200; `phone` 0–30; `email` 0–100 (empty or contains `@`).
- `rates.reloadCommissionBp`, `rates.ezcashCommissionBp`: integers 0–10000, both required when `rates` given.
- `printDefaults`: array 1–30 items; `code` `^[A-Z0-9_]{1,20}$` unique within array; `name` 1–60; `priceCents`, `costCents` integers 0–100000000.
- Empty body `{}` → `400 VALIDATION_ERROR`.
Response `200`: the full settings object (same shape as GET).
Side effect: one `audit_logs` row per changed section: `entity='settings'`, `entityId=<section>`, `action='update'`, `before`/`after` = section JSON. Unchanged sections are not logged.

### `GET /api/v1/audit-logs?entity=&limit=&beforeId=`
- `entity` optional exact match; `limit` 1–200 (default 50); `beforeId` optional (keyset pagination, returns rows with `id < beforeId`), newest first.
`200`
```json
{ "items": [ { "id": 12, "at": "…", "entity": "settings", "entityId": "rates", "action": "update", "before": {…}, "after": {…}, "note": null } ], "nextBeforeId": 12 }
```
`nextBeforeId` is null when there are no more rows.

### `GET /api/v1/backups`
`200`
```json
{ "items": [ { "name": "viman-20261110-113000-startup.db", "reason": "startup", "sizeBytes": 49152, "createdAt": "2026-11-10T06:00:00.000Z" } ] }
```
Newest first. Only files matching the backup name pattern are listed. `reason` ∈ `startup | manual | pre-restore`.

### `POST /api/v1/backups`
Body: none or `{}`. Creates a manual backup. `201` → `{ "item": { ...same shape... } }`.
Errors: `500 BACKUP_FAILED`.

### `POST /api/v1/backups/restore`
Two forms:
1. JSON `{ "name": "viman-20261110-113000-manual.db", "confirm": "RESTORE" }` — restore an existing backup.
2. `multipart/form-data` with field `confirm=RESTORE` and file field `file` (≤ 200 MB) — restore an uploaded `.db`.

`200`
```json
{ "restoredFrom": "viman-20261110-113000-manual.db", "safetyBackup": "viman-20261110-114500-pre-restore.db", "schemaVersion": 2 }
```
For uploads `restoredFrom` is `"upload:<original filename>"`.
Errors:
| status | code | when |
|---|---|---|
| 400 | `RESTORE_CONFIRM_REQUIRED` | `confirm` missing or not exactly `RESTORE` |
| 400 | `VALIDATION_ERROR` | bad name format / no file |
| 404 | `BACKUP_NOT_FOUND` | named backup does not exist |
| 422 | `RESTORE_INVALID_FILE` | not a SQLite database (header check / cannot open) |
| 422 | `RESTORE_INTEGRITY_FAILED` | `PRAGMA integrity_check` ≠ `ok` |
| 422 | `RESTORE_SCHEMA_MISSING` | no `schema_migrations` table or required tables missing |
| 422 | `RESTORE_SCHEMA_TOO_NEW` | backup schema version > app's latest migration |
| 409 | `RESTORE_IN_PROGRESS` | another restore is running (in practice the global guard answers every request during a restore with **503** `RESTORE_IN_PROGRESS` first) |
| 413 | `FILE_TOO_LARGE` | uploaded file over 200 MB |
| 500 | `RESTORE_FAILED` | the swap or post-restore migration failed; previous data was put back from the safety backup |
On any validation failure the live database is untouched; on `RESTORE_FAILED` it is put back from the safety backup. The swap itself is an atomic same-folder file rename.

Backup name pattern: `^viman-\d{8}-\d{6}-(startup|manual|pre-restore)(-\d{1,3})?\.db$` (suffix used only when two backups land in the same second). Names are validated before any filesystem access (no path traversal).

---

## Phase 2 endpoints — Catalog (categories, products, suppliers)

Catalog data is **not financial**: no `clientRef`, no business date, no R-FD/R-RD. All writes are audited (`audit_logs`: entity `category` | `product` | `supplier`, `entityId` = id as text, action `create`/`update`, before/after = the full item JSON). No hard deletes — retire with `active: false`. Unchanged values in a PUT write no audit row. Stock fields are **read-only** here (always 0 in Phase 2); stock arrives with Phases 3/4/13.

Numeric/boolean **query** params are strings validated in the route (no coercion): integers `^[0-9]{1,9}$`, booleans exactly `true` | `false`. Unknown query params → `400 VALIDATION_ERROR`. Path `:id` must be digits, else `400`; unknown id → `404 NOT_FOUND`.

Common errors: `400 VALIDATION_ERROR` (fields keyed by JSON path), `404 NOT_FOUND`, `409 DUPLICATE_NAME` (`fields.name`, "Another … already uses this name." — comparison is case-insensitive, after trimming), `409 DUPLICATE_CODE` (`fields.code`).

### Categories
`Category` = `{ id, name, book: "shop"|"telecom", isDefault, active, productCount, createdAt, updatedAt }` (`productCount` = all products incl. inactive).

- `GET /api/v1/categories?active=&book=` → `{ items: Category[] }` ordered by `book` (shop first), then `name`.
- `POST /api/v1/categories` `{ name, book }` → `201 { item }`. `name` 1–60 trimmed; `book` required.
- `PUT /api/v1/categories/:id` — any of `{ name, book, active }`, `minProperties: 1` → `200 { item }`.
  - The 12 **default** categories (seeded by migration `003`) have `isDefault: true`: their `name` and `book` can never change → `409 DEFAULT_CATEGORY_LOCKED`. They may be deactivated/reactivated.
  - `book` of an owner-created category can change only while `productCount = 0` → `409 CATEGORY_HAS_PRODUCTS`.
  - Deactivating a category keeps its products; new products (or a product moved) cannot use an inactive category (`400 CATEGORY_INACTIVE`, `fields.categoryId`).

Default categories (shop): Phone Accessories, Tempered Glass, Phone Covers, Electronics, Stationery, Snacks and Drinks, Party Items, Perfume, Pooja Items, SIM, Other · (telecom): Scratch Cards.

### Products
`Product` = `{ id, code: string|null, name, description, categoryId, categoryName, kind: "stock"|"service", book: "shop"|"telecom", sellPriceCents, minPriceCents, reorderLevel, active, qtyOnHand, stockValueCents, avgUnitCostCents: number|null, lowStock, createdAt, updatedAt }`.
- `book` is derived from the category (never sent by the client).
- `avgUnitCostCents` = `mulDivRound(stockValueCents, 1, qtyOnHand)` when `qtyOnHand > 0`, else `null` (display only — BUSINESS_RULES §3).
- `lowStock` = `kind = "stock" AND active AND reorderLevel > 0 AND qtyOnHand <= reorderLevel`.

- `GET /api/v1/products?q=&book=&categoryId=&lowStock=&active=&limit=&offset=` → `{ items: Product[], total }`. `q`: case-insensitive substring of name **or** code (LIKE wildcards in `q` are escaped). `limit` 1–500 (default 100), `offset` ≥ 0. Order: `name` (case-insensitive), then `id`.
- `GET /api/v1/products/:id` → `{ item }`.
- `POST /api/v1/products` `{ code?, name, description?, categoryId, kind, sellPriceCents, minPriceCents, reorderLevel? }` → `201 { item }` (qty and value start at 0).
  - `code`: optional, trimmed; empty string = no code; 1–30 chars; unique case-insensitively (`409 DUPLICATE_CODE`). `name` 1–120 trimmed. `description` 0–500 (default ""). `reorderLevel` integer ≥ 0 (default 0).
  - `sellPriceCents`, `minPriceCents`: integers 0–`999999999`; **`minPriceCents ≤ sellPriceCents`** else `400` with `fields.minPriceCents` = "Minimum price cannot be higher than the selling price."
  - `kind = "service"`: `reorderLevel` must be 0 (`fields.reorderLevel`); services never hold stock.
  - `categoryId` must exist (`400 VALIDATION_ERROR` `fields.categoryId` "Choose a category.") and be active (`400 CATEGORY_INACTIVE`).
- `PUT /api/v1/products/:id` — any of `{ code, name, description, categoryId, sellPriceCents, minPriceCents, reorderLevel, active }`, `minProperties: 1` → `200 { item }`. `code: null` or `""` clears the code.
  - `kind` is **immutable** (sending it → `400`, `additionalProperties: false`). The category may change **only within the same book** (`400 CATEGORY_BOOK_MISMATCH`, `fields.categoryId`) — so `book` never changes.
  - Price and `reorderLevel` rules are validated against the **merged** (existing + patch) values.
  - Setting `active: false` is always allowed (stock history is never lost).

### Suppliers
`Supplier` = `{ id, name, phone, notes, active, createdAt, updatedAt }`.
- `GET /api/v1/suppliers?q=&active=` → `{ items: Supplier[] }` (name order; `q` substring of name or phone).
- `POST /api/v1/suppliers` `{ name, phone?, notes? }` → `201 { item }`. `name` 1–120; `phone` 0–30; `notes` 0–500.
- `PUT /api/v1/suppliers/:id` — any of `{ name, phone, notes, active }`, `minProperties: 1` → `200 { item }`.

### Internal module contracts (Phase 2, server)
Repositories take the connection first, contain SQL only, map snake_case → camelCase, return plain numbers (convert bigint) and booleans (0/1 → boolean). Time stamps via SQL default / `strftime('%Y-%m-%dT%H:%M:%fZ','now')`.

`server/src/repositories/categories.repo.ts`
```ts
export interface CategoryRow { id: number; name: string; book: 'shop'|'telecom'; isDefault: boolean; active: boolean; productCount: number; createdAt: string; updatedAt: string }
export function listCategories(conn, q: { active?: boolean; book?: 'shop'|'telecom' }): CategoryRow[];
export function getCategory(conn, id: number): CategoryRow | undefined;
export function findCategoryByName(conn, name: string): CategoryRow | undefined;      // case-insensitive
export function insertCategory(conn, c: { name: string; book: 'shop'|'telecom' }): number;
export function updateCategory(conn, id: number, patch: { name?: string; book?: 'shop'|'telecom'; active?: boolean }): void; // sets updated_at
```
`server/src/repositories/products.repo.ts`
```ts
export interface ProductRow { id; code: string|null; name; description; categoryId; categoryName; kind: 'stock'|'service'; book: 'shop'|'telecom'; sellPriceCents; minPriceCents; reorderLevel; active: boolean; qtyOnHand; stockValueCents; createdAt; updatedAt }
export interface ProductQuery { q?: string; book?; categoryId?: number; lowStock?: boolean; active?: boolean; limit: number; offset: number }
export function listProducts(conn, q: ProductQuery): { items: ProductRow[]; total: number };
export function getProduct(conn, id: number): ProductRow | undefined;
export function findProductByName(conn, name: string): ProductRow | undefined;       // case-insensitive
export function findProductByCode(conn, code: string): ProductRow | undefined;       // case-insensitive
export function insertProduct(conn, p: { code: string|null; name; description; categoryId; kind; book; sellPriceCents; minPriceCents; reorderLevel }): number;
export function updateProduct(conn, id: number, patch: { code?: string|null; name?; description?; categoryId?; book?; sellPriceCents?; minPriceCents?; reorderLevel?; active?: boolean }): void; // sets updated_at
```
`server/src/repositories/suppliers.repo.ts` — `SupplierRow`, `listSuppliers(conn,{q?,active?})`, `getSupplier`, `findSupplierByName`, `insertSupplier(conn,{name,phone,notes})`, `updateSupplier(conn,id,patch)` (same conventions).

Services (`server/src/services/catalog.service.ts` or one per entity) own validation, trimming, case-insensitive uniqueness checks, derived fields (`book`, `avgUnitCostCents`, `lowStock`), error codes and audit rows; each write runs inside one `database.tx()` together with its audit row. Routes are thin (JSON schema + call service). The database triggers/constraints in `003_catalog.sql` are the backstop: SQLite aborts surface as `INTERNAL_ERROR` only if the service missed a rule.

Web types (`web/src/types/api.ts`) mirror the shapes above; money in the UI uses the Phase 1 converters (`rupeesToCents`, `formatLKR`).

---

## Phase 3 endpoints — Purchases, stock movements, inventory

Rules in force (BUSINESS_RULES): §3 weighted-average pool, R4/C7 (purchase return & void), R11 (purchases are fully paid in cash from their book, book derived from the products, never mixed), R1/C6 (voids = reversal rows), R-FD, R-RD, §12 (business date vs posting time, audit), E-/R-rules unchanged. **DAY_CLOSED** and the negative-cash-balance warning arrive with the cash books (Phase 8) — Phase 3 does not enforce them. The cash ledger table is created now (owner decision 2026-11-10); only `purchase_payment` / `purchase_refund` entries are written until Phase 8.

All Phase 3 writes: JSON schema (no coercion, `additionalProperties:false`) → R-FD → lookups (404) → R-RD (returns) → business rules; one `database.tx()` for the whole write; audit row in the same transaction. `clientRef` (string 8–64 chars `[A-Za-z0-9_-]`) makes a repeat return the original result with `200` (create is `201`).

### Purchases
`PurchaseItem` = `{ id, productId, productName, packs, packSize, units, lineTotalCents, unitCostCents, returnedUnits }` (`units = packs × packSize`; `unitCostCents = mulDivRound(lineTotalCents, 1, units)` — display only).
`Purchase` = `{ id, businessDate, postedAt, backdated, supplierId|null, supplierName|null, billNo, book: "shop"|"telecom", totalCents, status: "posted"|"void", notes, voidedAt|null, voidReason|null, clientRef, items: PurchaseItem[], returns: PurchaseReturn[] }`.
`PurchaseReturn` = `{ id, purchaseId, businessDate, postedAt, backdated, refundCents, note, clientRef, items: [{ id, purchaseItemId, productId, productName, units, valueCents }] }` (`valueCents` = purchase-cost value refunded for those units).
`backdated` = `businessDate` earlier than today (Asia/Colombo) at posting.

- `POST /api/v1/purchases` `{ businessDate, supplierId?, billNo?, items: [{ productId, packs, packSize, lineTotalCents }], notes?, clientRef }` → `201 { item }`.
  - `items` 1–100. `packs`, `packSize` integers 1–1 000 000; `lineTotalCents` integer 0–99 999 999 999; `billNo` ≤ 40; `notes` ≤ 500.
  - Each product must exist (`400 VALIDATION_ERROR` `fields["items.N.productId"]`), be **active** and `kind = "stock"` (`400 PRODUCT_NOT_STOCKABLE`), all of **one book** else `400 MIXED_BOOKS` "Shop and Telecom items cannot be on one bill — please split into two bills." (R11). Same product on two lines is allowed (processed in order). `supplierId` must exist and be active.
  - `businessDate`: valid date, R-FD (`400 FUTURE_DATE_NOT_ALLOWED`, exact message in the conventions above). Backdating allowed.
  - Effects (one transaction): `purchases` + `purchase_items` rows; per line a **`purchase` stock movement** (`qtyDelta = +units`, `valueDeltaCents = +lineTotalCents`) via the inventory engine; one **`purchase_payment` cash entry** (`amountCents = −totalCents`, `book` = purchase book, `refTable='purchases'`) when `totalCents > 0`; audit row (entity `purchase`, action `create`, after = the Purchase JSON).
- `GET /api/v1/purchases?from=&to=&book=&supplierId=&status=&q=&limit=&offset=` → `{ items: Purchase[], total }` (items include their lines and returns). `from`/`to` are business dates (inclusive); `q` = case-insensitive substring of `billNo`; order `businessDate DESC, id DESC`; `limit` 1–200 default 50.
- `GET /api/v1/purchases/:id` → `{ item }`.
- `POST /api/v1/purchases/:id/void` `{ reason }` (reason 1–200 trimmed) → `200 { item }`.
  - `409 ALREADY_VOID`; `409 HAS_RETURNS` ("This purchase has returns, so it cannot be voided."); `422 INSUFFICIENT_STOCK` when any line's units are no longer all on hand ("Some of this purchase has already been sold or removed.", `fields["items.N"]` lists the line, with `onHand`).
  - Effects: status `void`, `voidedAt`/`voidReason` set; per line a **`purchase_void` movement** removing `units` at `min(lineTotalCents, pool value)` (R4) plus a value-only **`adjustment` residual-sweep movement** when the pool quantity reaches 0 with leftover value; a **reversal cash entry** (`+totalCents`, same type `purchase_payment`, `reversesEntryId` = the original entry, **business date copied from the purchase**, posting time = now). Audit row (action `void`).
- `POST /api/v1/purchases/:id/returns` `{ businessDate, items: [{ purchaseItemId, units }], note?, clientRef }` → `201 { item: PurchaseReturn, purchase: Purchase }`.
  - Validation order: schema → R-FD → purchase lookup `404` → **R-RD** (`400 RETURN_BEFORE_ORIGINAL_DATE`, message names the original date, `originalDate` in the error body) → `409 PURCHASE_VOID` → quantity rules → stock. `units` ≥ 1 and ≤ item `units − returnedUnits` (`422 RETURN_EXCEEDS_PURCHASED`, `fields["items.N.units"]`); each `purchaseItemId` must belong to this purchase (`400`). Each item at most once per request. Pool quantity must cover the units (`422 INSUFFICIENT_STOCK`).
  - Refund value per item (C7): `mulDivRound(lineTotalCents, units, item.units)`, except the return that brings the cumulative returned units to the item's full `units` takes the **remaining** value (`lineTotalCents − Σ earlier returned values`). `refundCents` = Σ values.
  - Effects: `purchase_returns` + items; item `returnedUnits` increased; per item a **`purchase_return` movement** removing `units` at `min(purchase-cost value, pool value)` (R4) with the residual sweep as above; one **`purchase_refund` cash entry** (`+refundCents`, book = purchase book, dated the return's business date); audit (entity `purchase_return`, action `create`). If `refundCents = 0` no cash entry.
  - The difference `refundCents − Σ value removed from stock` is not stored: it is derivable (cash entry vs movements) and is reported as a *Stock adjustment* in the P&L (BUSINESS_RULES R2/R4).

### Stock movements & inventory
`StockMovement` = `{ id, productId, businessDate, postedAt, type, qtyDelta, valueDeltaCents, unitCostCents|null, refTable|null, refId|null, reason }` — `type` ∈ `opening|purchase|purchase_return|purchase_void|sale|sale_return|sale_void|personal_use|loss|stocktake_gain|stocktake_loss|adjustment`.
- `GET /api/v1/products/:id/movements?from=&to=&type=&limit=&offset=` → `{ items: StockMovement[], total, product: Product }`; order `postedAt DESC, id DESC` (posting order); `limit` 1–200 default 50; `404` unknown product.
- `GET /api/v1/inventory/reconciliation` → `{ ok: boolean, checkedProducts, mismatches: [{ productId, name, cacheQty, movementQty, cacheValueCents, movementValueCents }] }` — compares each product's cached quantity/value with the sums of its movements (must always be `ok: true`).
- **No sale / loss / stocktake endpoints in Phase 3.** The engine functions below exist and are exercised by tests (including a `sale`-type removal that demonstrates average-cost COGS); public endpoints arrive in Phases 4–5.

### Internal module contracts (Phase 3, server)
**Stock cache is maintained by the database:** `AFTER INSERT ON stock_movements` adds `qty_delta` / `value_delta_cents` to `products.qty_on_hand` / `stock_value_cents` (existing CHECKs block negative stock/value). Application code **never writes the product cache** — it only inserts movements.

`server/src/services/inventory.service.ts` (Backend)
```ts
export type MovementType = 'opening'|'purchase'|'purchase_return'|'purchase_void'|'sale'|'sale_return'|'sale_void'|'personal_use'|'loss'|'stocktake_gain'|'stocktake_loss'|'adjustment';
export interface PoolState { qty: number; valueCents: number }
export function getPool(conn, productId: number): PoolState;                       // throws NOT_FOUND
// Inflow: adds qty and exact value (BUSINESS_RULES §3). qty ≥ 1, valueCents ≥ 0.
export function receiveStock(conn, p: { productId; businessDate: string; type: MovementType; qty: number; valueCents: number; refTable: string|null; refId: number|null; reason: string }): { movementId: number; unitCostCents: number };
// Outflow at weighted average: value = (qty === pool.qty) ? pool.valueCents : mulDivRound(pool.valueCents, qty, pool.qty). Blocks qty > pool.qty with AppError(422,'INSUFFICIENT_STOCK',…, details {onHand}).
export function issueStock(conn, p: { productId; businessDate; type: MovementType; qty: number; refTable; refId; reason }): { movementId: number; valueRemovedCents: number; unitCostCents: number };
// R4 removal for purchase return/void: removes qty at min(maxValueCents, pool.valueCents); if the pool quantity reaches 0 with value left, writes a value-only 'adjustment' sweep movement (qty 0, negative value) BEFORE the removal so every intermediate state is valid.
export function issueStockCapped(conn, p: { productId; businessDate; type: 'purchase_return'|'purchase_void'; qty: number; maxValueCents: number; refTable; refId; reason }): { movementId: number; valueRemovedCents: number; sweepMovementId: number|null; sweptCents: number };
export function reconcileStock(conn): { ok: boolean; checkedProducts: number; mismatches: Array<{ productId: number; name: string; cacheQty: number; movementQty: number; cacheValueCents: number; movementValueCents: number }> };
```
All amounts via `lib/money.ts` (`mulDivRound`); balances never computed in floating point.

`server/src/services/purchases.service.ts` (Backend): `createPurchase`, `listPurchases`, `getPurchase`, `voidPurchase`, `createPurchaseReturn` — validation, idempotency (`client_ref`), derived fields (`unitCostCents`, `backdated`), audit rows (before/after JSON incl. `businessDate`, `postedAt`, `backdated`).

Repositories (DB Architect; `conn` first, SQL only, camelCase rows, numbers/booleans converted):
- `stock-movements.repo.ts`: `insertMovement(conn, m: { productId; businessDate; type; qtyDelta; valueDeltaCents; unitCostCents: number|null; refTable; refId; reason }): number`; `listMovements(conn, q: { productId; from?; to?; type?; limit; offset }): { items: MovementRow[]; total: number }`; `sumMovements(conn): Array<{ productId; qty; valueCents }>`.
- `cash-entries.repo.ts`: `insertCashEntry(conn, e: { book; businessDate; type; amountCents; refTable; refId; reversesEntryId?: number|null; note?: string|null }): number`; `getCashEntry(conn, id)`; `findCashEntriesByRef(conn, refTable, refId)`; `cashBalance(conn, book): number`.
- `purchases.repo.ts`: `insertPurchase(conn, p: { businessDate; supplierId; billNo; book; totalCents; notes; clientRef }): number`; `insertPurchaseItem(conn, i): number`; `getPurchase(conn, id)` / `getPurchaseByClientRef(conn, ref)` (header rows); `listPurchaseItems(conn, purchaseId)`; `listPurchases(conn, q): { items: PurchaseHeaderRow[]; total }`; `markPurchaseVoid(conn, id, reason)`; `addReturnedUnits(conn, itemId, units)`; `insertPurchaseReturn(conn, r)`; `insertPurchaseReturnItem(conn, i)`; `getPurchaseReturnByClientRef`; `listPurchaseReturns(conn, purchaseId)`; `returnedValueSoFar(conn, purchaseItemId): number`.
- `audit.repo.ts` gains optional `businessDate?: string|null; backdated?: boolean` on `AuditInsert` and the same on `AuditRow`.

Audit rows: `audit_logs.business_date` (nullable) and `backdated` (0/1) columns exist from migration 004; `GET /audit-logs` items add `postedAt` (= `at`), `businessDate`, `backdated`. (Moved forward from Phase 8 because financial records now exist — BUSINESS_RULES §12.)

Web: `web/src/types/api.ts` mirrors the shapes above; purchases UI uses the Phase 1/2 converters; the purchase date picker defaults to `GET /health` `today` and has `max = today`; return forms limit the date range to *original date … today* (the server stays authoritative).

---

## Phase 4 endpoints — Stocktake, stock losses, personal use (goods drawings), valuation

Rules in force (BUSINESS_RULES): §3 (weighted-average pool, outflows at average, C10 gains), §9 (goods drawing at cost; no revenue/COGS/expense), §11 + R2/R3 (stock losses and stocktake differences form the *Stock adjustments (net)* line of the product's segment; goods drawings are **not** in it), C6/C9 (voids = exact negation, original business date), R-FD, §12 (business date vs posting time, audit). **No cash effect** in Phase 4. All writes: JSON schema (no coercion, `additionalProperties:false`) → R-FD → lookups (404) → business rules; one `database.tx()` containing the record(s), the stock movement(s) (via the Phase 3 inventory engine only — never write the product cache) and the audit row; `clientRef` (string 8–64 chars `[A-Za-z0-9_-]`) makes a repeat return the original with `200`.

**Reversal convention (C6):** voiding a stocktake, loss or goods drawing writes new movements with the **same type**, exactly **negated** `qtyDelta`/`valueDeltaCents` of the originals, `businessDate` copied from the original, posting time = the void time, `reason` = "Void of <record> #id". Original rows are never edited (append-only).

### Stocktake
`Stocktake` = `{ id, businessDate, postedAt, backdated, book, status: "draft"|"completed"|"void", notes, completedAt|null, voidedAt|null, voidReason|null, clientRef, items: StocktakeItem[] }`.
`StocktakeItem` = `{ id, productId, productName, productCode, countedQty, expectedQty, differenceQty, valueDeltaCents|null, gainUnitCostCents|null }`. In a **draft**, `expectedQty` is the product's *current* quantity (live) and `differenceQty = countedQty − expectedQty`, `valueDeltaCents` is `null`; in a **completed** stocktake they are the stored values at completion.

- `POST /api/v1/stocktakes` `{ businessDate, book: "shop"|"telecom", notes?, items?: [{ productId, countedQty, gainUnitCostCents? }], clientRef }` → `201 { item }` (status `draft`, no stock effect). `items`: ≤ 500, each product must exist, be `kind = "stock"` and belong to `book` (`400 PRODUCT_NOT_IN_BOOK`), no duplicates; `countedQty` integer 0–1 000 000 000; `gainUnitCostCents` integer 0–99 999 999 999.
- `PUT /api/v1/stocktakes/:id` `{ notes?, items? }` (`minProperties: 1`) → `200 { item }` — draft only (`409 NOT_DRAFT`); `items`, when present, **replaces** the whole list.
- `GET /api/v1/stocktakes?from=&to=&book=&status=&limit=&offset=` → `{ items: Stocktake[] (with items), total }` (`limit` 1–100, default 50; order `businessDate DESC, id DESC`); `GET /api/v1/stocktakes/:id` → `{ item }`.
- `POST /api/v1/stocktakes/:id/complete` `{}` → `200 { item }`. For every counted item, inside one transaction, in item order, against the **live** pool at that moment: `differenceQty = countedQty − pool.qty`.
  - `< 0` → `issueStock` type **`stocktake_loss`** (qty = |difference|, at the weighted average; whole value if the whole pool leaves).
  - `> 0` → `receiveStock` type **`stocktake_gain`**: value = `mulDivRound(pool.value, gain, pool.qty)` when pool `qty > 0` **and** `value > 0`; otherwise (C10) `gain × gainUnitCostCents` and `gainUnitCostCents` is **required** → `422 UNIT_COST_REQUIRED` with `fields["items.N.gainUnitCostCents"]` (nothing is posted). A supplied `gainUnitCostCents` is ignored when the average can be used.
  - `= 0` → no movement. Movements carry the stocktake's `businessDate`, `refTable = "stocktakes"`, reason "Stocktake #id".
  - Stores per item `expectedQty`, `differenceQty`, `valueDeltaCents` (signed: gain +, loss −), `gainUnitCostCents` (when used); sets `completedAt`; status `completed`. Errors: `409 NOT_DRAFT`; `400 VALIDATION_ERROR` when the draft has no items.
- `POST /api/v1/stocktakes/:id/void` `{ reason }` (1–200) → `200 { item }`. A **draft** is simply cancelled (status `void`, no movements). A **completed** stocktake is reversed per the reversal convention; `422 INSUFFICIENT_STOCK` ("Some of the stock added by this stocktake has already been used.") if a gain can no longer be removed; `409 ALREADY_VOID`.
- Audit: entity `stocktake`, actions `create` / `update` / `complete` / `void` (financial: `businessDate`, `backdated`).

### Stock losses
`StockLoss` = `{ id, businessDate, postedAt, backdated, productId, productName, book, qty, costCents, unitCostCents, reason: "damaged"|"lost"|"expired"|"other", note, source: "manual", status: "posted"|"void", voidedAt|null, voidReason|null, clientRef }` (`costCents` = value removed from the pool; `unitCostCents = mulDivRound(costCents, 1, qty)`).
- `POST /api/v1/stock-losses` `{ businessDate, productId, qty, reason, note?, clientRef }` → `201 { item }`. `qty` integer ≥ 1; `note` ≤ 500; product must exist and be `kind = "stock"` (`400 PRODUCT_NOT_STOCKABLE`; inactive products are allowed); `422 INSUFFICIENT_STOCK` when `qty` exceeds the quantity on hand. Effect: `issueStock` type **`loss`** at the weighted average (`refTable = "stock_losses"`), one `stock_losses` row (`costCents` = the value removed), audit (entity `stock_loss`). **Exactly once:** one loss row ↔ exactly one movement; repeating `clientRef` returns the original.
- `GET /api/v1/stock-losses?from=&to=&productId=&book=&reason=&status=&limit=&offset=` → `{ items: StockLoss[], total, totalCostCents }` (`totalCostCents` = Σ `costCents` of **posted** rows matching the filter). `GET /api/v1/stock-losses/:id` → `{ item }`.
- `POST /api/v1/stock-losses/:id/void` `{ reason }` → `200 { item }`: status `void`; reversal movement (type `loss`, `+qty`, `+costCents`, original business date); `409 ALREADY_VOID`.
- Damaged *sales returns* (`source = "damaged_return"`) are Phase 5.

### Personal use — goods drawings
`Drawing` = `{ id, businessDate, postedAt, backdated, book: "shop"|"telecom", kind: "goods"|"cash", amountCents, productId|null, productName|null, qty|null, note, status: "posted"|"void", voidedAt|null, voidReason|null, clientRef }` (`amountCents` for goods = the stock **cost** removed — never the selling price).
- `POST /api/v1/drawings` `{ kind: "goods", businessDate, productId, qty, note?, clientRef }` → `201 { item }`. `kind: "cash"` → `400 NOT_AVAILABLE_YET` (cash drawings arrive with the cash books, Phases 8–9). Same product/quantity checks as stock losses. Effect: `issueStock` type **`personal_use`** (`refTable = "owner_drawings"`), one `owner_drawings` row (`amountCents` = value removed, `book` = product's book), audit (entity `drawing`). No revenue, no COGS, no expense, no cash entry, **not** a stock loss.
- `GET /api/v1/drawings?kind=&from=&to=&book=&productId=&status=&limit=&offset=` → `{ items: Drawing[], total, totalAmountCents }` (posted only in the total); `GET /api/v1/drawings/:id`.
- `POST /api/v1/drawings/:id/void` `{ reason }` → reversal movement (type `personal_use`, `+qty`, `+amountCents`, original business date); `409 ALREADY_VOID`.

### Inventory valuation
- `GET /api/v1/inventory/valuation?book=&categoryId=&asOf=&includeZero=&includeInactive=` → `{ asOf: string|null, items: [{ productId, code, name, categoryId, categoryName, book, active, qty, valueCents, avgUnitCostCents|null }], totals: { qty, valueCents, byBook: { shop: { qty, valueCents }, telecom: { qty, valueCents } } } }`.
  - `asOf` is a **business date** (never rejected): quantities/values are Σ of movements with `business_date <= asOf`; omitted, or later than today (Asia/Colombo), the live pool is used (the same figures). `includeZero` default `false` (hides products with qty 0 and value 0); `includeInactive` default `true`. `avgUnitCostCents = mulDivRound(valueCents, 1, qty)` when `qty > 0` else `null`. Items ordered by `name` (case-insensitive). Telecom stock (scratch cards) is reported separately from Shop stock (`byBook`).

### Internal module contracts (Phase 4, server)
`services/inventory.service.ts` gains (Backend):
```ts
// Σ movements dated <= asOf per product (business-date basis), for valuation.
export function poolsAsOf(conn, asOf: string): Map<number, PoolState>;
// Value for a stocktake/opening gain per C10; throws AppError(422,'UNIT_COST_REQUIRED') when the pool cannot price it and no unit cost is given.
export function gainValue(pool: PoolState, gainQty: number, gainUnitCostCents: number | null): number;
// Reversal helper: inserts the exact negation of the given movements (same type, same business date), returning ids. Blocks (422 INSUFFICIENT_STOCK) when a negated inflow would drive qty or value below 0.
export function reverseMovements(conn, movementIds: number[], reason: string): number[];
```
Repositories (DB Architect): `stocktakes.repo.ts` (`insertStocktake`, `getStocktake`, `getStocktakeByClientRef`, `listStocktakes`, `replaceStocktakeItems`, `listStocktakeItems`, `completeStocktakeItem(conn, itemId, {expectedQty, differenceQty, valueDeltaCents, gainUnitCostCents})`, `markStocktakeCompleted`, `markStocktakeVoid`), `stock-losses.repo.ts` (`insertStockLoss`, `getStockLoss`, `getStockLossByClientRef`, `listStockLosses` with `totalCostCents`, `markStockLossVoid`), `drawings.repo.ts` (`insertDrawing`, `getDrawing`, `getDrawingByClientRef`, `listDrawings` with `totalAmountCents`, `markDrawingVoid`), and in `stock-movements.repo.ts` `listMovementsByRef(conn, refTable, refId): MovementRow[]` and `sumMovementsAsOf(conn, asOf)`; same conventions as Phase 3.

Web: `web/src/types/api.ts` mirrors the shapes above. The **Stock** section (sidebar) becomes real with tabs *Stock on hand* (valuation), *Stocktake*, *Stock losses*, *Personal use*; money/quantity inputs use the existing integer converters; the date picker defaults to `GET /health` `today` with `max = today`.

---

## Phase 5 endpoints — POS, sales, sales returns, voids

Rules in force (BUSINESS_RULES): §4 (cart split by book, lines in order, qty checked per product across the cart, R13 warnings, voids R1, returns R5/C5/R7), §3 (outflows at the weighted average, COGS snapshot), §2 (cash types), C6 (void = exact negation, original business date), R-FD, R-RD (sale date), §12 (business date vs posting time, audit). Scope: **stock products only** (`kind = "stock"`): Shop goods → book `shop`, line type `goods`; scratch cards (Telecom) → book `telecom`, line type `card`. Service products and printing arrive in Phase 7, reloads/EZCash in Phase 6: a `kind = "service"` product on a sale line → `400 PRODUCT_NOT_SELLABLE_YET`. `DAY_CLOSED` and the negative-cash-balance warning arrive with the cash books (Phase 8). Payment is always cash.

All writes: JSON schema (no coercion, `additionalProperties:false`) → R-FD → lookups (404) → R-RD (returns) → business rules; one `database.tx()` containing the record(s), stock movements (inventory engine only), cash entries and the audit row. `clientRef` (string 8–64 chars `[A-Za-z0-9_-]`) makes a repeat return the originals with `200`.

### Sales
`SaleItem` = `{ id, lineNo, lineType: "goods"|"card", productId, productName, productCode, qty, unitPriceCents, unitCostCents, revenueCents, cogsCents, returnedQty }` — `revenueCents = qty × unitPriceCents` (exact); `cogsCents` = the stock value actually removed at the weighted average at sale time and **never changes afterwards**; `unitCostCents = mulDivRound(cogsCents, 1, qty)` (snapshot, display).
`Sale` = `{ id, businessDate, postedAt, backdated, book: "shop"|"telecom", totalCents, cogsCents, grossProfitCents, status: "posted"|"void", notes, voidedAt|null, voidReason|null, clientRef, items: SaleItem[], returns: SaleReturn[] }` (`totalCents` = Σ revenue; `grossProfitCents = totalCents − cogsCents`, before returns; returns are shown on their own).
`SaleReturn` = `{ id, saleId, businessDate, postedAt, backdated, refundCents, cogsReversedCents, note, clientRef, items: [{ id, saleItemId, productId, productName, qty, resalable, revenueCents, cogsCents }] }`.

- `POST /api/v1/sales` `{ businessDate, items: [{ productId, qty, unitPriceCents }], notes?, clientRef }` → `201 { sales: Sale[], warnings: Warning[] }`.
  - `items` 1–100; `qty` integer 1–1 000 000; `unitPriceCents` integer 0–999 999 999 (editable by the cashier; defaults come from the product in the UI); `notes` ≤ 500.
  - Products must exist (`400 VALIDATION_ERROR` `fields["items.N.productId"]`), be `kind = "stock"` (`400 PRODUCT_NOT_SELLABLE_YET`) and **active** (`400 PRODUCT_INACTIVE`).
  - **Mixed carts:** the server groups lines by the product's book and creates **one sale per book** (Shop and Telecom stay separate, each with its own total, cash entry and `clientRef` scope); lines keep their cart order within each sale (`lineNo` 1…n per sale). `sales` is ordered shop first, then telecom.
  - Per line in cart order, against the live pool: `issueStock` type **`sale`** at the weighted average (`qty` checked cumulatively per product across the whole cart; `422 INSUFFICIENT_STOCK` with `fields["items.N.qty"]` and `onHand`, nothing saved). The value removed is the line's `cogsCents`.
  - Cash (R-FD aside): one cash entry per sale with `totalCents > 0`: `sale_goods` (+total, book `shop`) or `card_sale` (+total, book `telecom`), `refTable = "sales"`; business date = the sale's.
  - Audit: entity `sale`, action `create`, after = the Sale JSON.
  - `Warning` = `{ code, message, lineIndex }` — **never blocks** (R13): `PRICE_BELOW_MINIMUM` (unit price < product minimum price), `PRICE_BELOW_COST` (unit price < snapshot unit cost), `ZERO_COST` (qty > 0 but cogs 0).
- `GET /api/v1/sales?from=&to=&book=&status=&productId=&limit=&offset=` → `{ items: Sale[], total, totals: { revenueCents, cogsCents, refundsCents } }` (`totals` over **posted** sales matching the filter; `refundsCents` = Σ their returns' refunds). `from`/`to` business dates inclusive; order `businessDate DESC, id DESC`; `limit` 1–200 default 50. `GET /api/v1/sales/:id` → `{ item }`.
- `POST /api/v1/sales/:id/void` `{ reason }` (1–200) → `200 { item }`. `409 ALREADY_VOID`; `409 HAS_RETURNS` ("This sale has returns, so it cannot be voided."). Effects: status `void`; the sale's `sale` movements are **exactly negated** (stock and value restored at the original snapshot cost, original business date, posting time now — C6); the sale's cash entry is reversed (negated, same type, `reversesEntryId`, original business date); audit action `void`.

### Sales returns
- `POST /api/v1/sales/:id/returns` `{ businessDate, items: [{ saleItemId, qty, resalable }], note?, clientRef }` → `201 { item: SaleReturn, sale: Sale }`.
  - Validation order: schema → R-FD → sale lookup `404` → **R-RD** (`400 RETURN_BEFORE_ORIGINAL_DATE`, "The return date cannot be earlier than the original sale date ({date}). Please select {date} or a later date (not after today).", `originalDate` in the error body) → `409 SALE_VOID` → quantity rules. `qty` ≥ 1 and ≤ `sold − returnedQty` (`422 RETURN_EXCEEDS_SOLD`, `fields["items.N.qty"]`); each `saleItemId` must belong to the sale (`400`) and appear once per request; `resalable` boolean required.
  - Values (C5): revenue portion `mulDivRound(revenueCents, qty, item.qty)` and COGS portion `mulDivRound(cogsCents, qty, item.qty)`, except the return that brings the cumulative returned quantity to the item's full `qty` takes the **remainder** of both (so the sum over all returns equals the line exactly; each capped at the remaining amount). `refundCents` = Σ revenue portions.
  - **Resalable** (`resalable: true`): stock returns at the **original snapshot cost** — `receiveStock` type **`sale_return`** (`+qty`, `+cogs portion`, `refTable = "sales_returns"`).
  - **Damaged** (`resalable: false`): **no stock movement, no restock**; revenue and COGS are reversed and **exactly one `stock_losses` row** per damaged line is written (`source = "damaged_return"`, `reason = "damaged"`, `qty`, `costCents` = the COGS portion, the product's book, the return's business date, `salesReturnId` set) — the loss is therefore counted once (BUSINESS_RULES §4/R2).
  - Cash: one refund entry when `refundCents > 0`: `sale_refund` (book `shop`) or `card_refund` (book `telecom`), `−refundCents`, dated the return's business date.
  - Item `returnedQty` increased; audit entity `sale_return`, action `create`. A repeated `clientRef` returns the original with `200`; the same `clientRef` used on another sale → `409 CLIENT_REF_CONFLICT`.
- `GET /api/v1/stock-losses` items gain `salesReturnId: number|null` and `source` may now be `"damaged_return"` (Phase 4 contract: `source: "manual"` only). Voiding a damaged-return loss through `POST /stock-losses/:id/void` is **refused** (`409 DAMAGED_RETURN_LOSS`) — it belongs to its return.

### Internal module contracts (Phase 5, server)
Repositories (DB Architect): `sales.repo.ts` — `insertSale`, `insertSaleItem`, `getSale`, `getSaleByClientRef(conn, clientRef, book)`, `listSaleItems`, `listSales` (+ totals), `markSaleVoid`, `addReturnedQty`, `insertSaleReturn`, `insertSaleReturnItem`, `getSaleReturn`, `getSaleReturnByClientRef`, `listSaleReturns`, `listSaleReturnItems`, `returnedAmountsSoFar(conn, saleItemId): { qty, revenueCents, cogsCents }`; `stock-losses.repo.ts` gains `salesReturnId` on insert/rows and `source: 'damaged_return'` support. Services (Backend): `sales.service.ts` (`createSales`, `listSales`, `getSale`, `voidSale`, `createSaleReturn`), reusing `issueStock`, `receiveStock`, `reverseMovements`, `listMovementsByRef`, and the shared helpers in `services/validation.ts`.

Web: the **Sales** section (sidebar, now built): *POS* (product search by name/code with live stock and price, cart with editable qty/price, line and grand totals as integer sums, date picker `max = today`, Save sale, per-book result summary + warnings, today's sales), *History* (filters, paging, detail with returns, Void, Return items). `clientRef` generated when the POS opens and replaced after a successful save.

### Phase 5 amendment — editable sale cost / extra cost (BUSINESS_RULES C13)
- `POST /api/v1/sales` — each cart line accepts an optional `unitCostCents` (integer 0–999 999 999) = the **cost per unit to charge**. Omitted or equal to the automatic cost → `extraCostCents = 0`.
  - The **automatic cost** of a line is the weighted-average value the engine removes for it (its `cogsCents`). The line must satisfy `qty × unitCostCents ≥ cogsCents`; otherwise `422 COST_BELOW_AUTOMATIC` with `fields["items.N.unitCostCents"]` = "The cost cannot be lower than the automatic cost (Rs X.XX per unit). You can only increase it." and `minUnitCostCents = ceil(cogsCents / qty)` in the error body; nothing is saved.
  - `extraCostCents = qty × unitCostCents − cogsCents` (≥ 0; exact integers). The stock still leaves at `cogsCents`; no extra movement, no extra cash entry.
- `SaleItem` adds `extraCostCents` and `chargedCostCents` (= `cogsCents + extraCostCents`); `unitCostCents` stays the display snapshot of the **automatic** unit cost.
- `Sale` adds `extraCostCents` and `chargedCostCents` (sums over lines); `grossProfitCents = totalCents − chargedCostCents`. `GET /sales` `totals` adds `extraCostCents` and `costCents` (= automatic + extra, posted sales).
- `POST /sales/:id/returns`: each returned item also reverses its `extraCostCents` portion (same C5 remainder logic; the completing return takes the exact remainder); `SaleReturn` adds `extraCostReversedCents`; return items add `extraCostCents`. `cogsReversedCents` remains the automatic cost only. Stock restoration and damaged-return loss rows use the automatic cost only.
- Voiding a sale needs no change (the whole sale, including its extra cost, is excluded from totals).
- Warnings: `PRICE_BELOW_COST` still compares the price with the **automatic** unit cost.
- Web: the POS cart line shows **Cost per unit**, filled from the product's current average cost and editable upward; the server's rules above are authoritative (the UI sends `unitCostCents` only when the cashier changed it).

### Wave 1 contracts — Phases 6, 7, 13 (final; supersedes the "Planned endpoints" lines for these phases)
Conventions as Phase 3–5: `/api/v1`, `clientRef` idempotency (201 created / 200 repeated original), `businessDate` required on create, future date → `400 FUTURE_DATE_NOT_ALLOWED` (exact R-FD message), unknown properties rejected, list endpoints paged `limit/offset` (default 50, max 200) with `{ items, total, totals }`, void = `POST /<resource>/:id/void` with `{ reason }` (409 `ALREADY_VOID` on a second void), audit row for every write (with `business_date` and `backdated`), all writes in one `ctx.database.tx()`.

**Phase 6 — Telecom** (route file `routes/telecom.ts`)
- `GET /reload-providers` → `{ items: [{ id, name, commissionBp (effective = own or shop default), ownCommissionBp (null = default), active }] }`; `PUT /reload-providers/:id` `{ commissionBp: int 0–10000 | null, active: bool }` (audited; never changes existing sales).
- `POST /reload-sales` `{ businessDate, providerId, salesCents (int ≥1), extraCents? (int ≥0, default 0), notes?, clientRef }` → `{ item }`: commission = `mulDivRound(salesCents, rateBp, 10000) + extraCents`; rate snapshotted; cash +salesCents (`reload_collection`, book telecom). Inactive provider → `409 PROVIDER_INACTIVE`.
- `GET /reload-sales` filters `from,to,providerId,status`; `totals`: `salesCents, commissionCents, extraCents` (posted rows only). `GET /reload-sales/:id`; `POST /reload-sales/:id/void`.
- `POST /ezcash-sales` `{ businessDate, billTotalCents (≥1), notes?, clientRef }` (provider = Dialog automatically) → commission = `mulDivRound(billTotalCents, ezcashBp, 10000)`; cash +billTotal (`ezcash_collection`). `GET /ezcash-sales` (+`totals`: `billTotalCents, commissionCents`), `GET /ezcash-sales/:id`, `POST /ezcash-sales/:id/void`.
- `POST /telecom/topups` `{ businessDate, kind: 'provider_topup'|'wallet_topup', providerId? (required for provider_topup, forbidden for wallet_topup), amountCents (≥1), notes?, clientRef }` → cash −amount. `GET /telecom/topups` (+`totals` by kind), `GET /telecom/topups/:id`, `POST /telecom/topups/:id/void`.
- `GET /telecom/summary?from&to` → per-provider and total: `reloadSalesCents, reloadCommissionCents, ezcashBillCents, ezcashCommissionCents, topupsCents (provider/wallet), commissionRevenueCents` (posted rows; **revenue = commission only**).
- Scratch cards are ordinary stock products in the POS (Phase 5) — no Phase 6 endpoint.
- Web: `/telecom` tabs Reloads / EZCash / Top-ups (+ summary header and provider-rate editor inside the Reloads tab). Commission is previewed live with the same integer formula; the server value is authoritative.

**Phase 7 — Printing** (route file `routes/printing.ts`)
- `GET /print-service-types` (`?active=true`), `POST /print-service-types` `{ code (^[A-Z0-9_]{2,20}$), name, priceCents, costCents }` (`409 DUPLICATE_CODE`), `PUT /print-service-types/:id` `{ name, priceCents, costCents, active }` (audited; never changes past sales).
- `POST /print-sales` `{ businessDate, serviceTypeId, qty (int 1–1 000 000), unitPriceCents? (default = type price; may be changed), notes?, clientRef }` → snapshot cost = type cost; revenue = qty×unitPrice; cash +revenue (`sale_service`, book shop). Warning (not block, R13): `unitPriceCents < unitCostCents` → response `warnings: ['PRICE_BELOW_COST']`. Inactive type → `409 SERVICE_TYPE_INACTIVE`.
- `GET /print-sales` filters `from,to,serviceTypeId,status` + `totals { revenueCents, cogsCents, grossProfitCents }`; `GET /print-sales/:id`; `POST /print-sales/:id/void`.
- `POST /printing-supplies` `{ businessDate, amountCents, description, clientRef }` (cash −amount, `printing_supplies`, book shop; **no P&L**); `GET /printing-supplies` (+`totals`), `GET /printing-supplies/:id`, `POST /printing-supplies/:id/void`.
- Web: `/printing` tabs Print sales (quick entry buttons per service type + history) / Service types / Supplies.

**Phase 13 — Opening stock & Excel import** (route file `routes/opening-stock.ts`)
- `POST /opening-stock` `{ businessDate, items: [{ productId, qty (int ≥1), unitCostCents? | totalValueCents? (exactly one; value = exact entered total, or qty×unitCost) }], notes?, clientRef }` → creates one batch + one `opening` movement per line via the inventory engine (`receiveStock`, type opening) in one transaction. Unknown/inactive product → 422 with `fields["items.N.productId"]`. Duplicate product lines in one batch → 422 `DUPLICATE_PRODUCT`. Stock products only (shop/telecom cards); services have no stock.
- `GET /opening-stock` (batches, paged; `?from,to,status`), `GET /opening-stock/:id` (with lines), `POST /opening-stock/:id/void` `{ reason }` (R1 reversal; `409 OPENING_BATCH_IN_USE` per schema doc).
- `GET /excel/opening-stock-template` → `.xlsx` download (ExcelJS): sheet "Opening stock" with header row `SKU | Product name | Quantity | Unit cost (Rs) | Total value (Rs) | Notes`, sample row, data validation notes, plus sheet "Products" listing every active stock product (SKU, name, category, unit). Header names are the contract for the import.
- `POST /excel/opening-stock/preview` multipart (`file` ≤ 5 MB, `.xlsx` only, `businessDate` field, default today) → `{ importRunId, rows: [{ rowNo, sku, productId, productName, qty, unitCostCents, totalValueCents, status 'ok'|'error', issues: [{ code, message }] }], summary { total, ok, failed, totalValueCents }, fileSha256 }`. **Nothing is written to stock.** Row validation codes: `MISSING_SKU`, `UNKNOWN_SKU`, `INACTIVE_PRODUCT`, `BAD_QTY`, `BAD_COST` (cost/total both missing or both present and inconsistent beyond the exact integer rule), `DUPLICATE_SKU_IN_FILE`, `FUTURE_DATE_NOT_ALLOWED` (per R-FD if a row/date is in the future). Money cells parsed as exact decimals (Rs with up to 2 dp, no float math; thousands commas allowed).
- `POST /excel/opening-stock/import` same multipart + `clientRef` field → **all-or-nothing**: if any row has an error → `422 IMPORT_HAS_ERRORS` with the row list and **nothing is saved**; else one batch (source excel) is committed atomically; `409 IMPORT_ALREADY_COMMITTED` for the same file hash. Returns `{ batch, importRunId, summary }`.
- Excel **export** of reports is Phase 11/12 (not here). Web: `/opening-stock` tabs Manual entry / Excel import (download template → upload → preview table with per-row issues → confirm).

### Wave 2 contract — Phase 8 (expenses, cash books, opening balances, cash counts, daily closings, DAY_CLOSED)
Conventions as before (clientRef idempotency, R-FD, paging, void = `POST …/:id/void { reason }`, audit row per write with business date + backdated, one transaction per write). Route files `routes/expenses.ts`, `routes/cashbooks.ts`.
- **Expenses:** `POST /expenses` `{ businessDate, book: 'shop'|'telecom', category, amountCents (≥1, ≤10^12), description, notes?, clientRef }` → `{ item, warnings[] }`. `category: 'electricity'` → `400 ELECTRICITY_NOT_ALLOWED` ("Electricity is paid from the Ice Cream book.", `fields.category`); `book: 'icecream'` → `400 USE_ICECREAM_PAYMENTS`. Any other category value → 400 `VALIDATION_ERROR`. `GET /expenses` (filters `from,to,book,category,status`; `totals { amountCents }` posted only; paged), `GET /expenses/:id`, `POST /expenses/:id/void`. `GET /expenses/categories` → list with labels.
- **Cash books:** `GET /cashbooks` → `{ books: [{ book, balanceCents, funds? (icecream: { cost, electricity, profit } balances), lastClosedDate }] }` (all-time ledger balance; Ice Cream funds from `icecream_fund_entries`; `warnings` if a balance < 0 or Σ funds ≠ book). `GET /cashbooks/:book?from&to&limit&offset` → `{ book, from, to, openingCents (ledger balance with business_date < from), inCents, outCents, closingCents (= opening + in − out), items: [{ id, businessDate, postedAt, type, amountCents (signed), runningBalanceCents, fund, refTable, refId, reversesEntryId, note }], total, closedDates: [...] }` — ordered by business date then id; running balance carried correctly across pages. Ice Cream adds `funds` (per-fund opening/in/out/closing for the period).
- **Opening balance:** `POST /cashbooks/:book/opening` `{ businessDate, amountCents (≥1), fund? (required iff icecream: `400 FUND_REQUIRED`; others `400 FUND_NOT_ALLOWED`), note?, clientRef }` → `{ item, warnings }`; second posted opening for the same (book, fund) → `409 OPENING_BALANCE_EXISTS`. `GET /cashbooks/:book/opening`, `POST /capital-entries/:id/void` (opening balance void; `409 DAY_CLOSED` rules apply).
- **Cash counts:** `POST /cash-counts` `{ businessDate, book, countedCents (≥0), fund? (required iff icecream and difference ≠ 0), note? (required iff difference ≠ 0 → `400 NOTE_REQUIRED`), clientRef }` → `{ item { expectedCents, countedCents, differenceCents }, warnings }`; `GET /cash-counts` (`book,from,to,status`), `GET /cash-counts/:id`, `POST /cash-counts/:id/void`. `GET /cash-counts/expected?book&businessDate` → `{ expectedCents }` (for the UI).
- **Daily closings:** `POST /daily-closings` `{ book, businessDate, countedCents?, fund?, note?, clientRef }`: computes expected as of that date; if `countedCents` is given and differs it posts the cash count + adjustment first (same rules), then marks the day closed; already closed → `409 DAY_ALREADY_CLOSED`. `POST /daily-closings/:id/reopen` `{ reason (required, ≥3 chars) }` (audited; `409 DAY_NOT_CLOSED`). `GET /daily-closings?book&from&to` (each with `isClosed`), `GET /daily-closings/status?book&businessDate` → `{ isClosed }`.
- **DAY_CLOSED enforcement (R9):** every financial write — create **and void** — whose business date falls on a closed day of **any book it touches** → `409 DAY_CLOSED`, message "That day is closed for the <Shop|Telecom|Ice Cream> cash book. Reopen it first (it will be recorded in the audit log).", `error.book`, `error.businessDate`. Voids and returns are judged on the **record's / return's business date** (a void's reversal copies the original date). Applies to all existing write services: purchases (+returns, voids), sales (+returns, voids), stocktake post, stock losses, goods drawings, opening stock batches (voids), reload/EZCash/top-up, print sales/supplies, expenses, opening balance, cash counts. Books touched: purchases/sales → the document's book; stock-only writes (stocktake, loss, goods drawing, opening stock) → the book of each product involved; Phase 6/7 records → telecom / shop. **Validation order:** schema → R-FD → (returns: lookup, R-RD) → DAY_CLOSED → other business rules. One shared helper (e.g. `services/day-closing.ts` `assertDayOpen(ctx, books, date)`) is used by every service; no per-service copies of the rule.
- **Negative cash warning (R13):** every cash-out write returns `warnings: [{ code: 'NEGATIVE_CASH_BALANCE', message, book, balanceCents }]`-style entries via one shared helper (replace the printing-specific string warning so all services use the same shape; keep `PRICE_BELOW_COST` as is). Never a block.
- Web: **Expenses** page (book + category filters, add dialog with Shop/Telecom switch and the electricity note "Electricity is paid from the Ice Cream book", history with paging and void); **Cash Books** page (tabs Shop / Telecom / Ice Cream; period picker; balance cards; ledger table with running balance and fund column for Ice Cream; actions: set opening balance, cash count, close day, reopen day; closed-day badge; Ice Cream fund balances block). Existing forms need no change beyond showing the `DAY_CLOSED` message and the negative-cash warning through the shared toast.

---

## Planned endpoints (later phases — shapes finalised in their phase, listed here so the UI shell knows the map)
- **P2 Catalog**: specified above (Phase 2 endpoints).
- **P3 Inventory**: specified above (purchases, movements, reconciliation). **P4**: specified above (stocktake, stock losses, goods drawings, valuation). **P13**: `POST /opening-stock` (opening stock entry/import).
- **P5 Sales**: specified above (POS sales, history, returns, voids).
- **P6 Telecom**: `GET/PUT /reload-providers` · `POST/GET /reload-sales` · `POST/GET /ezcash-sales` · `POST/GET /telecom/topups`
- **P7 Printing**: `GET/POST /print-service-types`, `PUT /print-service-types/:id` · `POST /printing-supplies`
- **P8 Money**: `POST/GET /expenses`, `POST /expenses/:id/void` · `GET /cashbooks/:book?from&to` · `POST /cashbooks/:book/opening` · `POST /cash-counts` · `POST /daily-closings`, `POST /daily-closings/:id/reopen`
  - **Electricity rule (BUSINESS_RULES §7 E1–E5):** `POST /expenses` accepts `book` ∈ `shop|telecom` only and `category` ∈ `water|rent|internet|transport|repairs|cleaning_supplies|packaging|stationery|other`. (All books: `409 DAY_CLOSED` applies to every financial write dated in a closed day, including voids — BUSINESS_RULES R9.)
    - `category: "electricity"` → `400 ELECTRICITY_NOT_ALLOWED` — "Electricity is paid from the Ice Cream book." (`fields.category`)
    - `book: "icecream"` → `400 USE_ICECREAM_PAYMENTS` — ice-cream costs are recorded via `/icecream/payments`.
  - **Funds (§10.2):** for `book = icecream`, `opening` and `cash-counts` (over/short) require `fund` ∈ `cost|electricity|profit` (`400 FUND_REQUIRED`); for other books `fund` is rejected (`400 FUND_NOT_ALLOWED`). Ice Cream cash-book entries in `GET /cashbooks/icecream` carry their `fund`.
- **P9**: `POST/GET /cash-transfers`, `POST /cash-transfers/:id/void` · `POST/GET /drawings` · `POST/GET /capital`
  - `fromFund` required when `fromBook = icecream`, `toFund` when `toBook = icecream`; drawings and capital in the Ice Cream book require `fund`. None of these ever change recognized profit; capital/opening/transfer-in money is never profit-eligible.
- **P10 Ice cream (BUSINESS_RULES §10 — final, P-1 approved with D1–D4)**. Every write is one transaction: business record + fund-ledger rows + cash entry (if cash moves) + audit row. All writes take `clientRef` (idempotent).
  - Every Ice Cream write dated in a closed day → `409 DAY_CLOSED` (reopen first, R9). `fund` is **required** in every API body; the defaults in §10.2 (Cost for materials, Electricity for the bill, Profit for over/short) are UI presets only.
  - `POST /icecream/days` `{ businessDate, salesCents, costAllocCents, electricityAllocCents, items?, confirmNegativeProfit?, clientRef }` → `{ day: { …, profitShareCents }, funds, warnings }` — profit share server-computed; `422 NEGATIVE_PROFIT_UNCONFIRMED` without confirmation.
  - `PUT /icecream/days/:date` (void-and-replace, judged on the final state) · `POST /icecream/days/:date/void` — `409 DAY_CLOSED` unless reopened; `422 VOID_BREAKS_RELEASE` ("profit already released depends on this entry — reverse the release first") when the §10.4 void guard (D2) fails.
  - `GET /icecream/days?from&to`
  - `GET /icecream/funds?asOf=` → fund balances and recognized profit returned **separately**:
    `{ funds: { cost: { balanceCents }, electricity: { balanceCents }, profit: { balanceCents } }, totalCents, cashBookBalanceCents, lines: { materials: { chargedCents, settledCents, unspentCents }, electricity: { chargedCents, settledCents, unspentCents } }, unspentAllocationCents, outstandingExcessCostCents, recognizedProfitToDateCents, profitAfterExcessCostToDateCents, warnings: [{ code: "NEGATIVE_FUND_BALANCE" | "EXCESS_COST_OUTSTANDING", message, … }] }`
  - `POST /icecream/fund-moves/preview` `{ fromFund, toFund, amountCents }` → `{ profitEligibleCents, cashOnlyCents, chargeRelabelCents, profitEffectCents, explanation, warnings }` — no write; the UI shows this before confirmation.
  - `POST /icecream/fund-moves` `{ businessDate, fromFund, toFund, amountCents, confirmSplit?, confirmedProfitEligibleCents?, note?, clientRef }` → `{ move: { …, profitEffectCents, chargeRelabelCents, cashOnlyCents }, funds, warnings }`
    - `400 SAME_FUND`.
    - **D4:** a move into Profit with `amountCents` > profit-eligible limit and without `confirmSplit: true` → `409 SPLIT_CONFIRMATION_REQUIRED` `{ profitEligibleCents, cashOnlyCents, explanation }` (nothing posted). Resent with `confirmSplit: true` and `confirmedProfitEligibleCents` → the server recomputes; if the split changed meanwhile it answers `409 SPLIT_CONFIRMATION_REQUIRED` again with the new split; otherwise it posts one record with both parts.
    - Negative fund balances only produce `warnings`.
  - `POST /icecream/fund-moves/:id/void` — `422 VOID_BREAKS_RELEASE` for re-allocations and Cost↔Electricity moves when the void guard fails; releases can always be voided.
  - `POST /icecream/payments` `{ businessDate, kind: "materials" | "electricity_bill" | "other_cost", fund, amountCents, category?, description, clientRef }` → `{ payment: { …, pnlTreatment: "settlement" | "expense" }, funds, warnings }` — `category: "electricity"` → `400 ELECTRICITY_NOT_ALLOWED` (use `kind: "electricity_bill"`). `pnlTreatment` is derived: `expense` only for `other_cost` paid from the Profit fund. · `POST /icecream/payments/:id/void`
  - History: `GET /icecream/payments?from&to`, `GET /icecream/fund-moves?from&to`, `GET /icecream/funds/entries?fund&from&to` (complete fund ledger incl. reversals).
- **P11/P12 Reports** (`?from&to&granularity=day|month&format=json|xlsx`): `/reports/pnl/shop|telecom|icecream|combined`, `/reports/cashbook/:book`, `/reports/transfers`, `/reports/inventory/valuation`, `/reports/stock-movements`, `/reports/stock-losses`, `/reports/product-profitability`, `/reports/low-stock`, `/reports/purchases`, `/reports/sales`, `/reports/drawings`, `/reports/printing-variance`, `/reports/icecream-funds`, `/dashboard`
  - **D3 rule for every report that shows Ice Cream or Combined profit** (daily rows, monthly rows, any period, totals, dashboard) — BUSINESS_RULES §10.6: each row is computed **only from movements dated inside that row's period** and carries `recognizedProfitCents` (period), `excessCostNotChargedCents` (= change in uncovered excess during the period; may be negative), `profitAfterExcessCostCents` (= recognized − excess change). These three are additive (daily rows sum to the month). `outstandingExcessCostCents` (as of period end) is informational for the warning only and is never summed. A `warnings` entry `EXCESS_COST_OUTSTANDING` appears whenever outstanding excess > 0. Excess cost is never deducted from official profit.
  - `/reports/pnl/icecream` (per day or month row and total) → `{ salesCents, materialsChargeCents, electricityChargeCents, otherExpensesCents, cashOverShortCents, recognizedProfitCents, recognition: { dailyProfitShareCents, profitEligibleReleasesCents, reallocationsCents, otherExpensesCents, cashOverShortCents }, memo: { actualMaterialsPaidCents, actualElectricityPaidCents, otherCostsFromCostElecFundsCents }, excessCostNotChargedCents, profitAfterExcessCostCents, balancesAsOfPeriodEnd: { unspentByLine: { materialsCents, electricityCents }, outstandingExcessCostCents }, warnings }` — charge lines are movements dated in the period; `recognition` components are signed contributions to profit (re-allocations negative); `balancesAsOfPeriodEnd` is never summed (a total row carries the value at `to`)`
  - `/reports/icecream-funds` → per fund: opening, + allocations, + opening/capital/transfers in, ± moves (with profit-eligible / cash-only split), − payments, − drawings/transfers out, ± over/short, = closing; total = Ice Cream cash book; recognized profit, `excessCostNotChargedCents`, `profitAfterExcessCostCents` (period flows) and `outstandingExcessCostCents` with the warning, shown in a separate block from the fund balances.
  - `/reports/pnl/combined` → `recognizedProfitCents` per segment (Shop, Telecom, Ice Cream) and combined (official), `electricityChargedCents` (Ice Cream electricity charge for the period) and `electricityBillsPaidCents` (memo) **plus** `icecreamExcessCostNotChargedCents` (period change), `combinedProfitAfterExcessCostCents`, `outstandingExcessCostCents`, the excess-cost warning, and an informational electricity line (E5).
  - `/dashboard` → Ice Cream tile shows recognized profit, fund balances (separately) plus today's and this month's `excessCostNotChargedCents` / `profitAfterExcessCostCents` (period flows), `outstandingExcessCostCents` and the excess-cost warning when present.
  - `/reports/backdated?from&to&book` → every record whose `businessDate` is earlier than the Colombo date of its `postedAt`, with both values, the record type, amount and the audit entry id.
- **P13 Excel**: `GET /excel/opening-stock-template`, `POST /excel/opening-stock/preview`, `POST /excel/opening-stock/import` — `preview` and `import` take one `businessDate` for the opening stock (default today in Asia/Colombo); a future `businessDate` → `400 FUTURE_DATE_NOT_ALLOWED`; a future date in a row's date column is reported in the preview as an `import_issues` row with the R-FD message and that row is not imported.
- **System**: `GET /go-live` (checklist status)

`book` ∈ `shop | telecom | icecream`.

---

## Internal module contracts (Phase 1, server)

These TypeScript signatures are the hand-off between agents. Relative imports use `.ts` extensions. Only erasable TS syntax.

### `server/src/db/db.ts` (DB Architect)
```ts
import type { DatabaseSync } from 'node:sqlite';
export class AppDatabase {
  constructor(filePath: string);          // opens + applies PRAGMAs (journal_mode=WAL, foreign_keys=ON, busy_timeout=5000, synchronous=FULL)
  readonly filePath: string;
  get conn(): DatabaseSync;               // throws DB_CLOSED error if closed
  get isOpen(): boolean;
  tx<T>(fn: (conn: DatabaseSync) => T): T; // BEGIN IMMEDIATE / COMMIT; ROLLBACK + rethrow on error; nested call → SAVEPOINT/RELEASE
  close(): void;                          // idempotent; checkpoints WAL (PRAGMA wal_checkpoint(TRUNCATE)) before closing
  reopen(): void;                         // close() if open, then open again with PRAGMAs
}
export function openDatabase(filePath: string): DatabaseSync; // raw open + PRAGMAs (used by AppDatabase)
```
`tx()` must not use async functions (node:sqlite is synchronous); passing an async fn should throw.

### `server/src/db/migrate.ts` (DB Architect)
```ts
import type { DatabaseSync } from 'node:sqlite';
export interface MigrationFile { version: number; name: string; checksum: string; sql: string }
export const MIGRATIONS_DIR: string;                       // absolute path to ./migrations
export function loadMigrations(dir?: string): MigrationFile[];   // sorted; file names ^\d{3}_[a-z0-9_]+\.sql$; duplicate versions → throw
export function checksumOf(sql: string): string;           // sha256 hex of text with CRLF→LF
export function currentVersion(conn: DatabaseSync): number; // 0 if table missing/empty
export function latestVersion(dir?: string): number;
export function migrate(conn: DatabaseSync, dir?: string): { applied: string[]; version: number };
// - creates schema_migrations IF NOT EXISTS
// - for already-applied versions: checksum mismatch → throw Error code MIGRATION_CHECKSUM_MISMATCH
// - each pending file runs inside its own transaction together with its schema_migrations insert
// - database version > latestVersion → throw MIGRATION_DB_TOO_NEW
export const REQUIRED_TABLES: readonly string[];            // ['schema_migrations','settings','audit_logs'] for Phase 1
```

### `server/src/repositories/settings.repo.ts` (DB Architect)
```ts
export interface SettingsRow { key: string; valueJson: string; updatedAt: string }
export function getAllSettings(conn: DatabaseSync): SettingsRow[];
export function getSetting(conn: DatabaseSync, key: string): SettingsRow | undefined;
export function upsertSetting(conn: DatabaseSync, key: string, valueJson: string): void; // sets updated_at = now
```

### `server/src/repositories/audit.repo.ts` (DB Architect)
```ts
export interface AuditInsert { entity: string; entityId?: string | null; action: string; beforeJson?: string | null; afterJson?: string | null; note?: string | null }
export interface AuditRow { id: number; at: string; entity: string; entityId: string | null; action: string; beforeJson: string | null; afterJson: string | null; note: string | null }
export function insertAudit(conn: DatabaseSync, row: AuditInsert): number;   // returns id
export function listAudit(conn: DatabaseSync, q: { entity?: string; limit: number; beforeId?: number }): AuditRow[]; // id DESC
```

### `server/src/lib/money.ts` (Backend)
```ts
export function isCents(n: unknown): n is number;                    // safe integer
export function mulDivRound(a: number, b: number, c: number): number; // exact BigInt; half away from zero; c ≠ 0; all args safe integers; result must be safe integer else throw RangeError
export function applyBp(amountCents: number, bp: number): number;    // mulDivRound(amountCents, bp, 10000)
export function rupeesToCents(input: string | number): number;      // "1,320.50" → 132050, "15" → 1500, "-2.5" → -250; >2 decimals or junk → throw RangeError
export function formatLKR(cents: number): string;                    // 1234567 → "Rs. 12,345.67"; -123450 → "-Rs. 1,234.50"; 0 → "Rs. 0.00"
```

### `server/src/lib/dates.ts` (Backend)
```ts
export const BUSINESS_TZ = 'Asia/Colombo';
export function todayBusinessDate(now?: Date): string;  // YYYY-MM-DD in Asia/Colombo
export function isIsoDate(s: string): boolean;          // strict YYYY-MM-DD and a real calendar date
export function nowIso(): string;                       // new Date().toISOString()
export function backupStamp(now?: Date): string;        // YYYYMMDD-HHmmss in Asia/Colombo
```

### `server/src/lib/errors.ts` (Backend)
```ts
export class AppError extends Error {
  readonly statusCode: number; readonly code: string; readonly fields?: Record<string, string>;
  constructor(statusCode: number, code: string, message: string, fields?: Record<string, string>);
}
```
(Declare fields explicitly and assign in the constructor — parameter properties are not erasable.)

### `server/src/app.ts` (Backend)
```ts
export interface AppOptions { dataDir: string; webDistDir?: string | null; logger?: boolean }
export interface AppContext { database: AppDatabase; dataDir: string; backupsDir: string; dbPath: string; appVersion: string; isRestoring: boolean }
export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; ctx: AppContext }>;
// - mkdir dataDir/backups; open <dataDir>/viman.db; migrate; register routes under /api/v1; static web if webDistDir exists
// - does NOT create the startup backup (index.ts does) so tests control backups
// - app.addHook('onClose') closes the database
```

### `server/src/services/backup.service.ts` (Backend)
```ts
export type BackupReason = 'startup' | 'manual' | 'pre-restore';
export interface BackupInfo { name: string; reason: BackupReason; sizeBytes: number; createdAt: string }
export const BACKUP_NAME_RE: RegExp;
export const KEEP_REGULAR = 30; export const KEEP_PRE_RESTORE = 10;
export function createBackup(ctx: AppContext, reason: BackupReason, now?: Date): BackupInfo; // VACUUM INTO tmp → rename; then rotate
export function listBackups(ctx: AppContext): BackupInfo[];                                  // newest first
export function rotateBackups(ctx: AppContext): string[];                                    // returns deleted names
export function validateDatabaseFile(filePath: string): { schemaVersion: number };          // throws AppError(422, RESTORE_*)
export function restoreFromFile(ctx: AppContext, sourcePath: string, label: string): { restoredFrom: string; safetyBackup: string; schemaVersion: number };
```

### Wave 1 — implementation notes (as built, 2026-11-11)
- **Telecom:** `GET /telecom/summary?from&to` → `{from,to,providers[],totals}`; per provider `reloadSalesCents, reloadCommissionCents (incl. extra), ezcashBillCents, ezcashCommissionCents, topupsCents, commissionRevenueCents`; totals add `reloadExtraCents, providerTopupsCents, walletTopupsCents, topupsCents`. Top-up list totals `{providerTopupCents, walletTopupCents, totalCents}`. EZCash always uses `settings.rates.ezcashCommissionBp` (Dialog's own rate is its reload rate only) and is not blocked when Dialog reloads are inactive. Provider top-up to an inactive provider → 409 `PROVIDER_INACTIVE`. Unknown provider or wrong providerId usage → 400 `VALIDATION_ERROR` (`fields.providerId`).
- **Printing:** create responses are `{ item, warnings[] }` (`PRICE_BELOW_COST`; supplies also `NEGATIVE_CASH_BALANCE`, R13). Limits: price/cost ≤ 1,000,000,000 cents, qty ≤ 1,000,000, one supplies purchase ≤ 10^12 cents. Unknown `serviceTypeId` → 400 `VALIDATION_ERROR`. `GET /print-service-types` includes `sortOrder`. Audit entities `print_service_type`, `print_sale`, `printing_supply`.
- **Opening stock:** added codes `INVALID_PRODUCT` (422), `INVALID_FILE_TYPE`, `INVALID_FILE` (400), `FILE_TOO_LARGE` (413), `MISSING_SHEET`, `MISSING_HEADERS`, `EMPTY_FILE`, `TOO_MANY_ROWS` (>5000) (422), `CLIENT_REF_CONFLICT` (409). Preview adds `alreadyCommitted`. `IMPORT_HAS_ERRORS` carries `rows, summary, importRunId, fileSha256` in the `error` object. The same-file guard applies only while the earlier batch is still posted (a corrected file can be re-imported after a void). Required headers: SKU, Quantity, Unit cost (Rs), Total value (Rs); the template's Products sheet lists Book (not unit).
