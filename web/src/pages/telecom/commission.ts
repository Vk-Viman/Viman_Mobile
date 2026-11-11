/**
 * Live commission preview for the Telecom forms (BUSINESS_RULES section 5).
 *
 * The SAME integer formula as the server: commission = round(amount x rateBp / 10000) + extra, halves rounded up.
 * It is exact because it uses BigInt (no floating point). This is only a preview while the owner types; the server
 * recalculates and its stored value is the authoritative one.
 */

/** Largest single amount in cents the server accepts (API_CONTRACTS / migration 009). */
export const MAX_TELECOM_CENTS = 1_000_000_000_000;

/** round(amountCents x rateBp / 10000), halves up (amounts here are never negative). */
export function rateCommissionPreview(amountCents: number, rateBp: number): number {
  return Number((BigInt(amountCents) * BigInt(rateBp) + 5000n) / 10000n);
}

/** Reload commission preview: rate part + the owner's extra (>= 0). */
export function reloadCommissionPreview(salesCents: number, rateBp: number, extraCents: number): number {
  return rateCommissionPreview(salesCents, rateBp) + extraCents;
}
