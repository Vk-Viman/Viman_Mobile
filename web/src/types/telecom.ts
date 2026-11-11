/**
 * Types of the Telecom API (Phase 6): reload providers, reload sales, EZCash entries, top-ups and the period summary.
 * Mirrors API_CONTRACTS.md "Wave 1 contracts - Phase 6". Money is always integer cents, rates integer basis points
 * (600 bp = 6.00 %). The server calculates every figure; the screens only display them (and preview commission).
 */
import type { PostedStatus } from './api';
import type { CashWarning } from './cashbooks';

/** A reload provider. `commissionBp` is the EFFECTIVE rate (own rate, else the shop default); `ownCommissionBp` null = default. */
export interface ReloadProvider { id: number; name: string; commissionBp: number; ownCommissionBp: number | null; active: boolean }
export interface ProviderList { items: ReloadProvider[] }
export interface ProviderUpdate { commissionBp: number | null; active: boolean }
export interface ProviderOne { item: ReloadProvider }

/** Fields every telecom record carries. */
interface TelecomRecord {
  id: number; businessDate: string; postedAt: string; backdated: boolean; notes: string;
  status: PostedStatus; voidedAt: string | null; voidReason: string | null; clientRef: string;
}

/** One day's reload collection for a provider. `commissionCents` already includes `extraCents`. */
export interface ReloadSale extends TelecomRecord {
  providerId: number; providerName: string; salesCents: number; commissionBp: number; extraCents: number; commissionCents: number;
}
export interface ReloadSaleCreate {
  businessDate: string; providerId: number; salesCents: number; extraCents?: number; notes?: string; clientRef: string;
}
export interface ReloadSaleQuery { from?: string; to?: string; providerId?: number; status?: PostedStatus; limit?: number; offset?: number }
export interface ReloadSaleList {
  items: ReloadSale[]; total: number; totals: { salesCents: number; commissionCents: number; extraCents: number };
}
export interface ReloadSaleOne { item: ReloadSale }

/** EZCash bills collected (always under Dialog). */
export interface EzCashSale extends TelecomRecord {
  providerId: number; providerName: string; billTotalCents: number; commissionBp: number; commissionCents: number;
}
export interface EzCashSaleCreate { businessDate: string; billTotalCents: number; notes?: string; clientRef: string }
export interface EzCashSaleQuery { from?: string; to?: string; status?: PostedStatus; limit?: number; offset?: number }
export interface EzCashSaleList { items: EzCashSale[]; total: number; totals: { billTotalCents: number; commissionCents: number } }
export interface EzCashSaleOne { item: EzCashSale }

export type TopupKind = 'provider_topup' | 'wallet_topup';

/** Cash paid out to refill a provider or the EZCash wallet (`providerId` null for the wallet). */
export interface Topup extends TelecomRecord {
  kind: TopupKind; providerId: number | null; providerName: string | null; amountCents: number;
}
export interface TopupCreate { businessDate: string; kind: TopupKind; providerId?: number; amountCents: number; notes?: string; clientRef: string }
export interface TopupQuery {
  from?: string; to?: string; kind?: TopupKind; providerId?: number; status?: PostedStatus; limit?: number; offset?: number;
}
export interface TopupList {
  items: Topup[]; total: number; totals: { providerTopupCents: number; walletTopupCents: number; totalCents: number };
}
/** `warnings` (R13, shared negative-cash warnings) comes with a CREATE; a void answers without it. */
export interface TopupOne { item: Topup; warnings?: CashWarning[] }

/** Posted figures of one provider for the period. */
export interface ProviderSummary {
  providerId: number; name: string; reloadSalesCents: number; reloadCommissionCents: number; ezcashBillCents: number;
  ezcashCommissionCents: number; topupsCents: number; commissionRevenueCents: number;
}
/** Telecom summary: revenue = commission only (`commissionRevenueCents`). */
export interface TelecomSummary {
  from: string | null; to: string | null; providers: ProviderSummary[];
  totals: {
    reloadSalesCents: number; reloadCommissionCents: number; reloadExtraCents: number; ezcashBillCents: number;
    ezcashCommissionCents: number; providerTopupsCents: number; walletTopupsCents: number; topupsCents: number;
    commissionRevenueCents: number;
  };
}
export interface TelecomSummaryQuery { from?: string; to?: string }
