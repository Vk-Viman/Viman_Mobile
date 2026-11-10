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
