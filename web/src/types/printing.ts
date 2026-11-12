/**
 * TypeScript shapes of the Printing API (Phase 7): service types, print sales and printing supplies.
 *
 * Types only: no runtime code. Same conventions as types/api.ts: `...Cents` fields are integer cents, `businessDate`
 * is "YYYY-MM-DD" (never in the future, R-FD), `clientRef` is the duplicate-submission guard. See API_CONTRACTS.md
 * "Wave 1 contracts - Phase 7".
 */
import type { PostedStatus } from './api';
import type { CashWarning } from './cashbooks';

/** One entry of the print price list. `costCents` is the standard cost per page (snapshotted on each sale, R12). */
export interface PrintServiceType {
  id: number;
  /** Permanent, unique code such as BW_1S. */
  code: string;
  name: string;
  priceCents: number;
  costCents: number;
  active: boolean;
  sortOrder: number;
}
export interface PrintServiceTypeList { items: PrintServiceType[] }
export interface PrintServiceTypeOne { item: PrintServiceType }
export interface PrintServiceTypeCreate { code: string; name: string; priceCents: number; costCents: number }
export interface PrintServiceTypeUpdate { name: string; priceCents: number; costCents: number; active: boolean }

/** The advisory notice (R13) of a print sale; a negative cash book uses the shared `CashWarning` object instead. */
export type PrintWarning = 'PRICE_BELOW_COST';

/** One print sale with its frozen price, standard cost and the figures derived from them. */
export interface PrintSale {
  id: number;
  businessDate: string;
  postedAt: string;
  backdated: boolean;
  serviceTypeId: number;
  serviceTypeCode: string;
  /** The service type's name at the time of the sale. */
  description: string;
  qty: number;
  unitPriceCents: number;
  unitCostCents: number;
  revenueCents: number;
  cogsCents: number;
  grossProfitCents: number;
  status: PostedStatus;
  voidedAt: string | null;
  voidReason: string | null;
  notes: string;
  clientRef: string;
}
/** Totals of the POSTED sales that match the filters. */
export interface PrintSaleTotals { revenueCents: number; cogsCents: number; grossProfitCents: number }
export interface PrintSaleList { items: PrintSale[]; total: number; totals: PrintSaleTotals }
export interface PrintSaleOne { item: PrintSale; warnings: PrintWarning[] }
export interface PrintSaleVoidOne { item: PrintSale; warnings: CashWarning[] }
export interface PrintSaleQuery {
  from?: string; to?: string; serviceTypeId?: number; status?: PostedStatus; limit?: number; offset?: number;
}
export interface PrintSaleCreate {
  businessDate: string; serviceTypeId: number; qty: number; unitPriceCents?: number; notes?: string; clientRef: string;
}

/** One paper / toner purchase (a cash-out with no profit effect, R12). */
export interface PrintingSupply {
  id: number;
  businessDate: string;
  postedAt: string;
  backdated: boolean;
  amountCents: number;
  description: string;
  status: PostedStatus;
  voidedAt: string | null;
  voidReason: string | null;
  clientRef: string;
}
export interface PrintingSupplyList { items: PrintingSupply[]; total: number; totals: { amountCents: number } }
export interface PrintingSupplyOne { item: PrintingSupply; warnings: CashWarning[] }
export interface PrintingSupplyVoidOne { item: PrintingSupply }
export interface PrintingSupplyQuery { from?: string; to?: string; status?: PostedStatus; limit?: number; offset?: number }
export interface PrintingSupplyCreate { businessDate: string; amountCents: number; description: string; clientRef: string }
