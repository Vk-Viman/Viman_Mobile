export interface Health { status: 'ok'; appVersion: string; schemaVersion: number; time: string; today: string }

export interface ShopSettings { name: string; address: string; phone: string; email: string }
export interface RateSettings { reloadCommissionBp: number; ezcashCommissionBp: number }
export interface PrintDefault { code: string; name: string; priceCents: number; costCents: number }
export interface Settings {
  shop: ShopSettings;
  rates: RateSettings;
  printDefaults: PrintDefault[];
  updatedAt: string | null;
}
export interface SettingsUpdate {
  shop?: ShopSettings;
  rates?: RateSettings;
  printDefaults?: PrintDefault[];
}

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
export interface AuditLogPage { items: AuditLog[]; nextBeforeId: number | null }

export type BackupReason = 'startup' | 'manual' | 'pre-restore';
export interface Backup { name: string; reason: BackupReason; sizeBytes: number; createdAt: string }
export interface BackupList { items: Backup[] }
export interface BackupCreated { item: Backup }

export interface RestoreResult { restoredFrom: string; safetyBackup: string; schemaVersion: number }

export interface ApiErrorBody { error: { code: string; message: string; fields?: Record<string, string> } }

// ---- Phase 2: Catalog ----
export type Book = 'shop' | 'telecom';
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
  minPriceCents: number;
  reorderLevel: number;
  active: boolean;
  qtyOnHand: number;
  stockValueCents: number;
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
  limit?: number;
  offset?: number;
}
export interface ProductCreate {
  code?: string;
  name: string;
  description?: string;
  categoryId: number;
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
export interface PurchaseItem {
  id: number;
  productId: number;
  productName: string;
  packs: number;
  packSize: number;
  units: number;
  lineTotalCents: number;
  unitCostCents: number;
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
export interface PurchaseOne { item: Purchase }
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
  businessDate: string;
  items: { purchaseItemId: number; units: number }[];
  note?: string;
  clientRef: string;
}
export interface PurchaseReturnResult { item: PurchaseReturn; purchase: Purchase }

export type MovementType =
  | 'opening' | 'purchase' | 'purchase_return' | 'purchase_void' | 'sale' | 'sale_return' | 'sale_void'
  | 'personal_use' | 'loss' | 'stocktake_gain' | 'stocktake_loss' | 'adjustment';
export interface StockMovement {
  id: number;
  productId: number;
  businessDate: string;
  postedAt: string;
  type: MovementType;
  qtyDelta: number;
  valueDeltaCents: number;
  unitCostCents: number | null;
  refTable: string | null;
  refId: number | null;
  reason: string;
}
export interface MovementList { items: StockMovement[]; total: number; product: Product }
export interface MovementQuery { from?: string; to?: string; type?: MovementType; limit?: number; offset?: number }
export interface ReconciliationMismatch {
  productId: number;
  name: string;
  cacheQty: number;
  movementQty: number;
  cacheValueCents: number;
  movementValueCents: number;
}
export interface InventoryReconciliation { ok: boolean; checkedProducts: number; mismatches: ReconciliationMismatch[] }
