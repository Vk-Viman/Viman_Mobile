/**
 * services/icecream-moves.service.ts - Ice Cream fund moves: preview, post (with the D4 split confirmation), void (Phase 10).
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules (BUSINESS_RULES sections 10.2-10.4, 12):
 *  - 10.2  a move A -> B writes TWO fund-ledger rows (A -x, B +x) and NO cash entry; a fund may go negative (warning only).
 *  - 10.3  profit effect: Cost/Electricity -> Profit is a RELEASE (+ the profit-eligible part); Profit -> Cost/Electricity is a
 *          RE-ALLOCATION (D1: - the FULL amount); Cost <-> Electricity re-labels the charge and leaves profit unchanged.
 *  - 10.4  the profit-eligible limit = min(max(0, Unspent_L), max(0, Unspent)); a Cost <-> Electricity move re-labels
 *          min(x, max(0, Unspent_source)). Everything is computed from ALL posted rows (saving order, 10.6).
 *  - D4    a release above the limit is NOT posted until the owner confirms the split: the server answers
 *          `409 SPLIT_CONFIRMATION_REQUIRED` with the profit-eligible and cash-only amounts and a plain-language
 *          explanation. The confirmation carries the profit-eligible amount the owner saw; the server recomputes, and if the
 *          split changed meanwhile it answers again with the new split. A confirmed move is ONE atomic record with both parts.
 *  - D2    voiding a re-allocation or a Cost <-> Electricity move is blocked (`422 VOID_BREAKS_RELEASE`) when released profit
 *          depends on it; voiding a release (or a cash-only move) only loosens limits and is always allowed.
 *  - R9/R-FD/R1/section 12  closed days refuse create and void; no future dates; a void reverses the two fund rows (same
 *          business date); idempotent by `clientRef`; audited with business date and `backdated`; one transaction.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { formatLKR } from '../lib/money.ts';
import type { IceFund } from '../repositories/cash-entries.repo.ts';
import { fundBalances, findFundEntriesByRef, insertFundEntry } from '../repositories/icecream-funds.repo.ts';
import {
  getMove, getMoveByClientRef, insertMove, listMoves as listMoveRows, loadFacts, markMoveVoid,
} from '../repositories/icecream.repo.ts';
import type { IceStatus, MoveRow } from '../repositories/icecream.repo.ts';
import { logAudit } from './audit.service.ts';
import { negativeFundWarning, FUND_LABEL } from './cash-warnings.ts';
import type { CashWarning } from './cash-warnings.ts';
import { assertDayOpen } from './day-closing.ts';
import { voidBreaksRelease } from './icecream-days.service.ts';
import { lineOfFund, moveKind, planMove, standing, voidGuard, withoutMove } from './icecream-rules.ts';
import type { MoveKind, MovePlan } from './icecream-rules.ts';
import { writeExtras } from './icecream.service.ts';
import type { FundsSummary, IceWarning } from './icecream.service.ts';
import { runWrite } from './stock-common.ts';
import {
  NOTE_MAX_LENGTH, REASON_MAX_LENGTH, alreadyVoid, assertNoFieldErrors, checkBusinessDate, isBackdated, isBackdatedToday, notFound,
  trimmed,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** A fund move as returned by the API (adds `backdated`, the move `kind` and the derived `profitEligibleCents`). */
export interface IceMove {
  id: number; businessDate: string; postedAt: string; backdated: boolean; fromFund: IceFund; toFund: IceFund; amountCents: number;
  kind: MoveKind; profitEffectCents: number; chargeRelabelCents: number; cashOnlyCents: number; note: string; status: IceStatus;
  voidedAt: string | null; voidReason: string | null; clientRef: string;
}

function toMove(r: MoveRow): IceMove {
  return {
    id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, backdated: isBackdated(r.businessDate, r.postedAt),
    fromFund: r.fromFund, toFund: r.toFund, amountCents: r.amountCents, kind: moveKind(r.fromFund, r.toFund),
    profitEffectCents: r.profitEffectCents, chargeRelabelCents: r.chargeRelabelCents, cashOnlyCents: r.cashOnlyCents, note: r.note,
    status: r.status, voidedAt: r.voidedAt, voidReason: r.voidReason, clientRef: r.clientRef,
  };
}

function loadMove(conn: DatabaseSync, id: number): IceMove {
  const r = getMove(conn, id);
  if (!r) throw notFound('Fund move');
  return toMove(r);
}

/** Owner-facing line names for the explanations. */
const LINE_LABEL = { materials: 'materials', electricity: 'electricity' } as const;

/**
 * The plain-language explanation of a move plan (D4, 10.3): what happens to profit and to the cost charge, in words the
 * shop owner understands. For a release above the limit it names the cash-only part ("... will not count as profit").
 */
export function explainMove(plan: MovePlan, from: IceFund, to: IceFund): string {
  const amount = formatLKR(plan.amountCents);
  if (plan.kind === 'release') {
    const line = LINE_LABEL[lineOfFund(from) as 'materials' | 'electricity'];
    if (plan.cashOnlyCents === 0) {
      return `All of ${amount} is unspent ${line} allocation, so it will be counted as profit.`;
    }
    const why = `opening balance, capital or money already spent (or more than is left of the ${line} allocation)`;
    if (plan.profitEligibleCents === 0) {
      return `${formatLKR(plan.cashOnlyCents)} of this is ${why}, so it will not count as profit. The cash moves either way.`;
    }
    return `${formatLKR(plan.cashOnlyCents)} of this is ${why}, so it will not count as profit. `
      + `${formatLKR(plan.profitEligibleCents)} will be counted as profit. The cash moves either way.`;
  }
  if (plan.kind === 'reallocation') {
    return `Moving ${amount} from Profit back to ${FUND_LABEL[to]} lowers the recognized profit by the full ${amount}: `
      + `it is now charged as a ${LINE_LABEL[lineOfFund(to) as 'materials' | 'electricity']} cost.`;
  }
  const line = LINE_LABEL[lineOfFund(from) as 'materials' | 'electricity'];
  const other = LINE_LABEL[lineOfFund(to) as 'materials' | 'electricity'];
  if (plan.chargeRelabelCents === plan.amountCents) {
    return `${amount} moves from ${FUND_LABEL[from]} to ${FUND_LABEL[to]} and the ${line} cost charge moves to ${other} by the same amount. Profit is unchanged.`;
  }
  return `${amount} of cash moves from ${FUND_LABEL[from]} to ${FUND_LABEL[to]}, but only ${formatLKR(plan.chargeRelabelCents)} of the cost charge moves from ${line} to ${other} `
    + `(that is all that was still unspent). Profit is unchanged.`;
}

/** 400 SAME_FUND: a move needs two different funds. */
function assertDifferentFunds(from: IceFund, to: IceFund): void {
  if (from === to) {
    throw new AppError(400, 'SAME_FUND', 'Choose two different funds to move money between.', { toFund: 'Choose a different fund.' });
  }
}

/** What the preview answers (no write). */
export interface MovePreview {
  profitEligibleCents: number; cashOnlyCents: number; chargeRelabelCents: number; profitEffectCents: number;
  /** True when posting needs the owner's D4 confirmation. */
  needsConfirmation: boolean; kind: MoveKind; explanation: string; warnings: CashWarning[];
}

/**
 * Shows what a move WOULD do, without writing anything (the UI shows it before confirmation). Warns when the source fund
 * would go below zero. Computed from the current state of all posted rows (saving order).
 *
 * @throws AppError 400 SAME_FUND.
 */
export function previewMove(ctx: AppContext, body: { fromFund: IceFund; toFund: IceFund; amountCents: number }): MovePreview {
  assertDifferentFunds(body.fromFund, body.toFund);
  const conn = ctx.database.conn;
  const plan = planMove(standing(loadFacts(conn)), body.fromFund, body.toFund, body.amountCents);
  const warnings: CashWarning[] = [];
  const projected = fundBalances(conn)[body.fromFund] - body.amountCents;
  if (projected < 0) warnings.push(negativeFundWarning(body.fromFund, projected)); // 10.2: warn, never block
  return {
    profitEligibleCents: plan.profitEligibleCents, cashOnlyCents: plan.cashOnlyCents, chargeRelabelCents: plan.chargeRelabelCents,
    profitEffectCents: plan.profitEffectCents, needsConfirmation: plan.needsConfirmation, kind: plan.kind,
    explanation: explainMove(plan, body.fromFund, body.toFund), warnings,
  };
}

/** Request body of a move. */
export interface IceMoveCreate {
  businessDate: string; fromFund: IceFund; toFund: IceFund; amountCents: number; confirmSplit?: boolean;
  confirmedProfitEligibleCents?: number; note?: string; clientRef: string;
}

/** Result of a move write. */
export interface MoveWrite { move: IceMove; funds: FundsSummary; warnings: IceWarning[]; created: boolean }

/**
 * Posts a fund move: the record, two fund rows (A -x, B +x, kind `fund_move`), NO cash entry, audited, one transaction.
 * D4: a release above the profit-eligible limit needs `confirmSplit: true` AND `confirmedProfitEligibleCents` equal to the
 * profit-eligible amount the server computes now; otherwise `409 SPLIT_CONFIRMATION_REQUIRED` (nothing is posted) carries
 * the current split. Idempotent by `clientRef`.
 *
 * Validation order: schema -> SAME_FUND -> fields -> R-FD -> clientRef repeat -> DAY_CLOSED (R9) -> D4 confirmation.
 *
 * @throws AppError 400 VALIDATION_ERROR / SAME_FUND / FUTURE_DATE_NOT_ALLOWED, 409 DAY_CLOSED / SPLIT_CONFIRMATION_REQUIRED.
 */
export function createMove(ctx: AppContext, body: IceMoveCreate): MoveWrite {
  assertDifferentFunds(body.fromFund, body.toFund);
  const fields: Fields = {};
  const note = trimmed(fields, 'note', 'Note', body.note, 0, NOTE_MAX_LENGTH);
  assertNoFieldErrors(fields);
  checkBusinessDate(body.businessDate);

  return runWrite(ctx, (conn) => {
    const existing = getMoveByClientRef(conn, body.clientRef);
    if (existing) return { move: toMove(existing), ...writeExtras(conn, false), created: false };

    assertDayOpen(conn, ['icecream'], body.businessDate); // R9
    const plan = planMove(standing(loadFacts(conn)), body.fromFund, body.toFund, body.amountCents);
    if (plan.needsConfirmation) {
      const confirmed = body.confirmSplit === true && body.confirmedProfitEligibleCents === plan.profitEligibleCents;
      if (!confirmed) {
        const explanation = explainMove(plan, body.fromFund, body.toFund);
        throw new AppError(409, 'SPLIT_CONFIRMATION_REQUIRED', explanation, undefined, {
          profitEligibleCents: plan.profitEligibleCents, cashOnlyCents: plan.cashOnlyCents, explanation,
        });
      }
    }
    const id = insertMove(conn, {
      businessDate: body.businessDate, fromFund: body.fromFund, toFund: body.toFund, amountCents: body.amountCents,
      profitEffectCents: plan.profitEffectCents, chargeRelabelCents: plan.chargeRelabelCents, cashOnlyCents: plan.cashOnlyCents,
      note, clientRef: body.clientRef,
    });
    const rowNote = note || `Move ${FUND_LABEL[body.fromFund]} to ${FUND_LABEL[body.toFund]}`;
    // 10.2/10.7: two fund rows, no cash entry (the move nets to zero, so fund total = cash book still holds)
    insertFundEntry(conn, {
      businessDate: body.businessDate, fund: body.fromFund, amountCents: -body.amountCents, kind: 'fund_move',
      refTable: 'icecream_fund_moves', refId: id, note: rowNote,
    });
    insertFundEntry(conn, {
      businessDate: body.businessDate, fund: body.toFund, amountCents: body.amountCents, kind: 'fund_move',
      refTable: 'icecream_fund_moves', refId: id, note: rowNote,
    });
    const move = loadMove(conn, id);
    logAudit(conn, 'icecream_fund_move', String(id), 'create', null, move, undefined,
      { businessDate: move.businessDate, backdated: move.backdated });
    return { move, ...writeExtras(conn, false), created: true }; // negative fund: warning only
  });
}

/**
 * Voids a move (R1): both fund rows are reversed (kind `reversal`, same business date) and the move is marked `void`.
 * D2: a re-allocation or a Cost <-> Electricity move is refused when released profit depends on it; releases and
 * cash-only moves can always be voided.
 *
 * @throws AppError 400 VALIDATION_ERROR (reason), 404 NOT_FOUND, 409 DAY_CLOSED / ALREADY_VOID, 422 VOID_BREAKS_RELEASE.
 */
export function voidMove(ctx: AppContext, id: number, body: { reason: string }): { move: IceMove; funds: FundsSummary; warnings: IceWarning[] } {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runWrite(ctx, (conn) => {
    const row = getMove(conn, id);
    if (!row) throw notFound('Fund move');
    assertDayOpen(conn, ['icecream'], row.businessDate); // R9: judged on the move's own date
    if (row.status === 'void') throw alreadyVoid('fund move');
    if (moveKind(row.fromFund, row.toFund) !== 'release') {
      const facts = loadFacts(conn);
      if (voidGuard(standing(facts), standing(withoutMove(facts, id))).blocked) throw voidBreaksRelease('move'); // D2
    }
    const before = toMove(row);
    for (const f of findFundEntriesByRef(conn, 'icecream_fund_moves', id)) {
      if (f.kind === 'reversal') continue;
      insertFundEntry(conn, {
        businessDate: f.businessDate, fund: f.fund, amountCents: -f.amountCents, kind: 'reversal', refTable: f.refTable,
        refId: f.refId, reversesEntryId: f.id, note: `Void of fund move #${id}`,
      });
    }
    markMoveVoid(conn, id, reason);
    const move = loadMove(conn, id);
    logAudit(conn, 'icecream_fund_move', String(id), 'void', before, move, reason,
      { businessDate: move.businessDate, backdated: isBackdatedToday(move.businessDate) });
    return { move, ...writeExtras(conn, false) };
  });
}

/** Lists moves newest first; totals count only POSTED moves. */
export function listIceMoves(ctx: AppContext, q: { from?: string; to?: string; status?: IceStatus; limit: number; offset: number }): {
  items: IceMove[]; total: number; totals: { amountCents: number; profitEffectCents: number; cashOnlyCents: number };
} {
  const r = listMoveRows(ctx.database.conn, q);
  return { items: r.items.map(toMove), total: r.total, totals: r.totals };
}
