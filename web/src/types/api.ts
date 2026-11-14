/**
 * TypeScript shapes of everything the server API sends and receives (the "contract" in API_CONTRACTS.md).
 *
 * Types only: no runtime code. They let the compiler catch a typo in a field name before the owner ever sees it.
 * Naming pattern used below:
 *   Thing            one record as returned by the server
 *   ThingList        { items, total } list reply          ThingItem / ThingOne   { item } single-record reply
 *   ThingQuery       optional filters sent as ?query=string
 *   ThingCreate / ThingUpdate / ...Body   request bodies
 *
 * Conventions that apply to every type here (BUSINESS_RULES.md section 0):
 *  - Fields ending in `Cents` are INTEGER cents (Rs. 12.50 = 1250). Never decimals: floating point cannot hold
 *    money exactly. Fields ending in `Bp` are integer basis points (600 = 6.00%).
 *  - `businessDate` is a plain "YYYY-MM-DD" date in Asia/Colombo; it can be backdated but never in the future (R-FD).
 *    `postedAt`, `createdAt` and similar are ISO-8601 UTC timestamps set by the server.
 *  - `clientRef` is a random id the browser generates once per form opening and sends with a create request, so a
 *    retried/double-submitted request is recognised by the server and does not post twice (idempotency).
 *  - `backdated` is set by the server when the business date is earlier than the day it was posted.
 */
import type { CashWarning } from './cashbooks';

/** Reply of GET /health. `today` is the server's business date (Asia/Colombo) and is the date-picker maximum (R-FD). */
export interface Health { status: 'ok'; appVersion: string; schemaVersion: number; time: string; today: string }

// ---- Settings ----
export interface ShopSettings { name: string; address: string; phone: string; email: string }
/** Commission rates in basis points (600 = 6.00%). */
export interface RateSettings { reloadCommissionBp: number; ezcashCommissionBp: number }
/** A default print/copy service line: code, display name, selling price and cost, both in cents. */
export interface PrintDefault { code: string; name: string; priceCents: number; costCents: number }
/** Reply of GET /settings. */
export interface Settings {
  shop: ShopSettings;
  rates: RateSettings;
  printDefaults: PrintDefault[];
  updatedAt: string | null;
}
/** Body of PUT /settings: any subset of sections; sections left out stay unchanged. */
export interface SettingsUpdate {
  shop?: ShopSettings;
  rates?: RateSettings;
  printDefaults?: PrintDefault[];
}

// ---- Audit log ----
/** One audit-trail row: what changed (`before` -> `after`), on which entity, when and why. */
export interface AuditLog {
  id: number;
  at: string;
  entity: string;
  entityId: string | null;
  action: string;
  before: unknown;
  after: unknown;
  note: string | null;
}
/** One page of the audit list; `nextBeforeId` is the cursor for the next (older) page, null at the end. */
export interface AuditLogPage { items: AuditLog[]; nextBeforeId: number | null }

// ---- Backups ----
/** Why a backup was taken: automatically at startup, by the owner, or as a safety copy just before a restore. */
export type BackupReason = 'startup' | 'manual' | 'pre-restore';
export interface Backup { name: string; reason: BackupReason; sizeBytes: number; createdAt: string }
export interface BackupList { items: Backup[] }
export interface BackupCreated { item: Backup }

export interface RestoreResult { restoredFrom: string; safetyBackup: string; schemaVersion: number }

/** The standard error envelope every failed API call returns; decoded in api/client.ts. */
export interface ApiErrorBody { error: { code: string; message: string; fields?: Record<string, string>; [extra: string]: unknown } }

// ---- Phase 2: Catalog ----
/** The two accounting books of the shop (separate cash/profit tracking). */
export type Book = 'shop' | 'telecom';
/** 'stock' items are counted in inventory; 'service' items (e.g. printing) are not. */
export type ProductKind = 'stock' | 'service';

export interface Category {
  id: number;
  name: string;
  book: Book;
  isDefault: boolean;
  active: boolean;
  productCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface CategoryList { items: Category[] }
export interface CategoryItem { item: Category }
export interface CategoryCreate { name: string; book: Book }
export interface CategoryUpdate { name?: string; book?: Book; active?: boolean }

export interface Product {
  id: number;
  code: string | null;
  name: string;
  description: string;
  categoryId: number;
  categoryName: string;
  kind: ProductKind;
  book: Book;
  sellPriceCents: number;
  /** Lowest price a sale may use (guard against selling below the agreed floor). */
  minPriceCents: number;
  /** Quantity at or below which the product is flagged low on stock. */
  reorderLevel: number;
  active: boolean;
  /** Quantity currently in stock, as calculated by the server from the movement ledger. */
  qtyOnHand: number;
  /** Total value of that stock at moving-average cost, in cents (server-calculated). */
  stockValueCents: number;
  /** Average cost per unit in cents; null when there is no stock to average. */
  avgUnitCostCents: number | null;
  lowStock: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface ProductList { items: Product[]; total: number }
export interface ProductItem { item: Product }
export interface ProductQuery {
  q?: string;
  book?: Book;
  categoryId?: number;
  lowStock?: boolean;
  active?: boolean;
  /** Stock items only or services only (omit for both). */
  kind?: ProductKind;
  limit?: number;
  offset?: number;
}
export interface ProductCreate {
  code?: string;
  name: string;
  description?: string;
  /** Send exactly one of `categoryId` or `newCategory`. */
  categoryId?: number;
  /** Creates the category (in `book`) in the same request as the product. */
  newCategory?: { name: string; book: Book };
  kind: ProductKind;
  sellPriceCents: number;
  minPriceCents: number;
  reorderLevel?: number;
}
export interface ProductUpdate {
  code?: string | null;
  name?: string;
  description?: string;
  categoryId?: number;
  sellPriceCents?: number;
  minPriceCents?: number;
  reorderLevel?: number;
  active?: boolean;
}

export interface Supplier {
  id: number;
  name: string;
  phone: string;
  notes: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface SupplierList { items: Supplier[] }
export interface SupplierItem { item: Supplier }
export interface SupplierQuery { q?: string; active?: boolean }
export interface SupplierCreate { name: string; phone?: string; notes?: string }
export interface SupplierUpdate { name?: string; phone?: string; notes?: string; active?: boolean }

// ---- Phase 3: Purchases, stock movements ----
/** One line of a purchase: bought as `packs` of `packSize` units each; `units` = packs x packSize. */
export interface PurchaseItem {
  id: number;
  productId: number;
  productName: string;
  packs: number;
  packSize: number;
  units: number;
  lineTotalCents: number;
  /** Cost per unit derived by the server from the line total. */
  unitCostCents: number;
  /** Units of this line already returned to the supplier. */
  returnedUnits: number;
}
export interface PurchaseReturnItem {
  id: number;
  purchaseItemId: number;
  productId: number;
  productName: string;
  units: number;
  valueCents: number;
}
/** Goods returned to the supplier; `refundCents` is the money the supplier gives back. */
export interface PurchaseReturn {
  id: number;
  purchaseId: number;
  businessDate: string;
  postedAt: string;
  backdated: boolean;
  refundCents: number;
  note: string;
  clientRef: string;
  items: PurchaseReturnItem[];
}
/** 'void' purchases are cancelled but kept for the audit trail. */
export type PurchaseStatus = 'posted' | 'void';
export interface Purchase {
  id: number;
  businessDate: string;
  postedAt: string;
  backdated: boolean;
  supplierId: number | null;
  supplierName: string | null;
  billNo: string;
  book: Book;
  totalCents: number;
  status: PurchaseStatus;
  notes: string;
  voidedAt: string | null;
  voidReason: string | null;
  clientRef: string;
  items: PurchaseItem[];
  returns: PurchaseReturn[];
}
export interface PurchaseList { items: Purchase[]; total: number }
/** `warnings` (R13, shared negative-cash warnings) comes with a CREATE; a void answers without it. */
export interface PurchaseOne { item: Purchase; warnings?: CashWarning[] }
export interface PurchaseQuery {
  from?: string;
  to?: string;
  book?: Book;
  supplierId?: number;
  status?: PurchaseStatus;
  q?: string;
  limit?: number;
  offset?: number;
}
export interface PurchaseCreate {
  businessDate: string;
  supplierId?: number;
  billNo?: string;
  items: { productId: number; packs: number; packSize: number; lineTotalCents: number }[];
  notes?: string;
  clientRef: string;
}
export interface PurchaseVoidBody { reason: string }
export interface PurchaseReturnCreate {
  /** Must be between the purchase's own date and today (R-RD and R-FD); the server enforces it. */
  businessDate: string;
  items: { purchaseItemId: number; units: number }[];
  note?: string;
  clientRef: string;
}
export interface PurchaseReturnResult { item: PurchaseReturn; purchase: Purchase; warnings?: CashWarning[] }

/** Why a stock quantity changed; every change in stock is recorded as one movement of one of these types. */
export type MovementType =
  | 'opening' | 'purchase' | 'purchase_return' | 'purchase_void' | 'sale' | 'sale_return' | 'sale_void'
  | 'personal_use' | 'loss' | 'stocktake_gain' | 'stocktake_loss' | 'adjustment';
/** One row of the stock ledger: signed quantity and value change (negative = stock went down). */
export interface StockMovement {
  id: number;
  productId: number;
  businessDate: string;
  postedAt: string;
  type: MovementType;
  qtyDelta: number;
  valueDeltaCents: number;
  unitCostCents: number | null;
  /** The document that caused the movement (table name + row id), e.g. "purchases" / 12. */
  refTable: string | null;
  refId: number | null;
  reason: string;
}
export interface MovementList { items: StockMovement[]; total: number; product: Product }
export interface MovementQuery { from?: string; to?: string; type?: MovementType; limit?: number; offset?: number }
/** A product whose stored quantity/value does not match the sum of its movements (should never happen). */
export interface ReconciliationMismatch {
  productId: number;
  name: string;
  cacheQty: number;
  movementQty: number;
  cacheValueCents: number;
  movementValueCents: number;
}
export interface InventoryReconciliation { ok: boolean; checkedProducts: number; mismatches: ReconciliationMismatch[] }

// ---- Phase 4: Stocktake, stock losses, personal use, valuation ----
/** draft = still being counted, completed = adjustments posted, void = cancelled. */
export type StocktakeStatus = 'draft' | 'completed' | 'void';
export interface StocktakeItem {
  id: number;
  productId: number;
  productName: string;
  productCode: string | null;
  countedQty: number;
  /** What the system expected to be on the shelf when the count was taken. */
  expectedQty: number;
  differenceQty: number;
  valueDeltaCents: number | null;
  gainUnitCostCents: number | null;
}
export interface Stocktake {
  id: number;
  businessDate: string;
  postedAt: string;
  backdated: boolean;
  book: Book;
  status: StocktakeStatus;
  notes: string;
  completedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  clientRef: string;
  items: StocktakeItem[];
}
export interface StocktakeList { items: Stocktake[]; total: number }
export interface StocktakeOne { item: Stocktake }
export interface StocktakeQuery { from?: string; to?: string; book?: Book; status?: StocktakeStatus; limit?: number; offset?: number }
/** A counted quantity; `gainUnitCostCents` is the cost to give units found beyond what the system expected. */
export interface StocktakeItemInput { productId: number; countedQty: number; gainUnitCostCents?: number }
export interface StocktakeCreate { businessDate: string; book: Book; notes?: string; items?: StocktakeItemInput[]; clientRef: string }
export interface StocktakeUpdate { notes?: string; items?: StocktakeItemInput[] }

export type StockLossReason = 'damaged' | 'lost' | 'expired' | 'other';
/** Status shared by documents that can be cancelled: posted (live) or void (cancelled, kept for the record). */
export type PostedStatus = 'posted' | 'void';
export interface StockLoss {
  id: number;
  businessDate: string;
  postedAt: string;
  backdated: boolean;
  productId: number;
  productName: string;
  book: Book;
  qty: number;
  costCents: number;
  unitCostCents: number;
  reason: StockLossReason;
  note: string;
  /** Id of the sales return that created this loss (damaged returns); null for manual write-offs. */
  salesReturnId: number | null;
  /** 'manual' = written off by hand; 'damaged_return' = created by a damaged sales return (cannot be voided here). */
  source: 'manual' | 'damaged_return';
  status: PostedStatus;
  voidedAt: string | null;
  voidReason: string | null;
  clientRef: string;
}
export interface StockLossList { items: StockLoss[]; total: number; totalCostCents: number }
export interface StockLossOne { item: StockLoss }
export interface StockLossQuery {
  from?: string; to?: string; productId?: number; book?: Book; reason?: StockLossReason; status?: PostedStatus;
  limit?: number; offset?: number;
}
export interface StockLossCreate {
  businessDate: string; productId: number; qty: number; reason: StockLossReason; note?: string; clientRef: string;
}

/** Owner drawings: goods (stock taken for personal use) or cash. Only goods are created from the Stock screen. */
export interface Drawing {
  id: number;
  businessDate: string;
  postedAt: string;
  backdated: boolean;
  book: Book;
  kind: 'goods' | 'cash';
  amountCents: number;
  productId: number | null;
  productName: string | null;
  qty: number | null;
  note: string;
  status: PostedStatus;
  voidedAt: string | null;
  voidReason: string | null;
  clientRef: string;
}
export interface DrawingList { items: Drawing[]; total: number; totalAmountCents: number }
export interface DrawingOne { item: Drawing }
export interface DrawingQuery {
  kind?: 'goods' | 'cash'; from?: string; to?: string; book?: Book; productId?: number; status?: PostedStatus;
  limit?: number; offset?: number;
}
export interface DrawingCreate { kind: 'goods'; businessDate: string; productId: number; qty: number; note?: string; clientRef: string }

/** One product row of the stock valuation report: quantity and value at cost (server-calculated). */
export interface ValuationItem {
  productId: number;
  code: string | null;
  name: string;
  categoryId: number;
  categoryName: string;
  book: Book;
  active: boolean;
  qty: number;
  valueCents: number;
  avgUnitCostCents: number | null;
}
export interface BookTotals { qty: number; valueCents: number }
/** Stock valuation report; `asOf` null means "now". Totals are summed by the server, never by the browser. */
export interface Valuation {
  asOf: string | null;
  items: ValuationItem[];
  totals: { qty: number; valueCents: number; byBook: { shop: BookTotals; telecom: BookTotals } };
}
export interface ValuationQuery { book?: Book; categoryId?: number; asOf?: string; includeZero?: boolean; includeInactive?: boolean }

// ---------------------------------------------------------------------------------------------------------------
// Phase 5: sales (POS), sales returns, voids. Money is integer cents; the server computes every total, COGS and refund.
// ---------------------------------------------------------------------------------------------------------------

/** goods = Shop product, card = Telecom scratch card. */
export type SaleLineType = 'goods' | 'card';
export interface SaleItem {
  id: number;
  lineNo: number;
  lineType: SaleLineType;
  productId: number;
  productName: string;
  productCode: string | null;
  qty: number;
  unitPriceCents: number;
  /** Snapshot of the unit cost at sale time (display only; never changes afterwards). */
  unitCostCents: number;
  revenueCents: number;
  cogsCents: number;
  /** C13: extra cost the cashier added on top of the automatic cost (0 when unchanged). */
  extraCostCents: number;
  /** cogsCents + extraCostCents: the cost charged to this line. */
  chargedCostCents: number;
  returnedQty: number;
}
export interface SaleReturnItem {
  id: number;
  saleItemId: number;
  productId: number;
  productName: string;
  qty: number;
  /** true = back into stock; false = damaged (written off once as a stock loss). */
  resalable: boolean;
  revenueCents: number;
  cogsCents: number;
  /** C13: this item's share of the line's extra cost that the return reverses. */
  extraCostCents: number;
}
export interface SaleReturn {
  id: number;
  saleId: number;
  businessDate: string;
  postedAt: string;
  backdated: boolean;
  refundCents: number;
  /** Automatic cost reversed (stock restored/lost at this amount). */
  cogsReversedCents: number;
  /** C13: extra cost reversed by this return (0 when none). */
  extraCostReversedCents: number;
  note: string;
  clientRef: string;
  items: SaleReturnItem[];
  /** 'void' once the return was taken back (rule R-VR); a void return stays listed but no longer counts anywhere. */
  status: PostedStatus;
  voidedAt: string | null;
  voidReason: string | null;
}
export interface Sale {
  id: number;
  businessDate: string;
  postedAt: string;
  backdated: boolean;
  book: Book;
  totalCents: number;
  /** Automatic (weighted-average) cost. */
  cogsCents: number;
  /** C13: sum of the lines' extra cost. */
  extraCostCents: number;
  /** cogsCents + extraCostCents. */
  chargedCostCents: number;
  /** totalCents - chargedCostCents, before returns (returns are shown on their own). */
  grossProfitCents: number;
  status: PostedStatus;
  notes: string;
  voidedAt: string | null;
  voidReason: string | null;
  clientRef: string;
  items: SaleItem[];
  returns: SaleReturn[];
}
/** Non-blocking server warnings on a sale line (rule R13). */
export type WarningCode = 'PRICE_BELOW_MINIMUM' | 'PRICE_BELOW_COST' | 'ZERO_COST';
export interface Warning { code: WarningCode; message: string; lineIndex: number }
export interface SaleTotals {
  revenueCents: number;
  cogsCents: number;
  /** C13: extra cost over posted sales. */
  extraCostCents: number;
  /** Automatic + extra cost over posted sales. */
  costCents: number;
  refundsCents: number;
}
export interface SaleList { items: Sale[]; total: number; totals: SaleTotals }
export interface SaleOne { item: Sale }
/** POST /sales/:id/void: the voided sale plus the non-blocking R13 cash warnings. */
export interface SaleVoidResult { item: Sale; warnings: CashWarning[] }
export interface SaleQuery {
  from?: string; to?: string; book?: Book; status?: PostedStatus; productId?: number; limit?: number; offset?: number;
}
export interface SaleCreateLine {
  productId: number;
  qty: number;
  unitPriceCents: number;
  /** C13: cost per unit to charge; send ONLY when the cashier changed it (the server then enforces >= automatic). */
  unitCostCents?: number;
}
export interface SaleCreate { businessDate: string; items: SaleCreateLine[]; notes?: string; clientRef: string }
export interface SaleCreateResult { sales: Sale[]; warnings: Warning[] }
export interface SaleVoidBody { reason: string }
export interface SaleReturnCreate {
  businessDate: string;
  items: Array<{ saleItemId: number; qty: number; resalable: boolean }>;
  note?: string;
  clientRef: string;
}
export interface SaleReturnResult { item: SaleReturn; sale: Sale; warnings?: CashWarning[] }
/** POST /sales/:saleId/returns/:returnId/void (R-VR): the voided return, the updated sale and the shared cash warnings. */
export interface SaleReturnVoidResult { item: SaleReturn; sale: Sale; warnings: CashWarning[] }
