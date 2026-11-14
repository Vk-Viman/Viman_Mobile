# Proposal: "Edit" for saved transactions as void-and-replace

**Status: DESIGN ONLY. Nothing is implemented. Awaiting owner approval.**
No accounting rule changes in this proposal. No record is ever edited in place. Every ledger stays append-only. The proposal reuses the existing void services unchanged and only adds a way to run "void the original + enter the corrected one" as **one all-or-nothing action**.

---

## 1. The workflow (as requested)

1. Owner opens a saved transaction and presses **Edit** (button label suggestion: *Correct this entry*).
2. The screen explains: *"Editing does not change the original. The original will be voided (cancelled by reversal entries) and a corrected entry will be created. Both stay visible in history."*
3. Before anything is saved, the program runs an **eligibility check** (a dry run of the existing void rules) and shows either "this can be corrected" or the plain-language reason it cannot (for example "This sale has returns").
4. Owner types a **correction reason** (required) and enters the corrected details in the normal entry form, pre-filled from the original.
5. On **Save correction**, one database transaction runs: existing void of the original → existing create of the replacement. If either step is refused (closed day, insufficient stock, validation), **nothing changes**.
6. History shows both: the original marked *Void (corrected)* with a link to the replacement, and the replacement marked *Corrects #123* with the reason. Audit log records one "correct" event plus the normal void and create events.

## 2. Rules that apply to every type (no exceptions, no bypass)

| # | Rule |
|---|---|
| G1 | The original must be `posted`. A void original cannot be corrected (it was already cancelled; enter a new record instead). |
| G2 | The **existing void function** of that type is called unchanged. Every current guard still applies (R9 closed day, R-VR, HAS_RETURNS, INSUFFICIENT_STOCK, D2 release guard, DAMAGED_RETURN_LOSS...). If the void would be refused, the correction is refused with the same message. There is no new code path that skips a guard. |
| G3 | The replacement goes through the existing **create** function with the same validation (R-FD no future dates, closed days, ordering rule, stock availability, electricity rule, commission, etc.). |
| G4 | The original and replacement are two normal records; the reversal rows of the void follow R1 (same business date as the original, linked to the originals). |
| G5 | Default replacement date = the original's business date (the period is not silently moved). The owner may choose another date allowed by R-FD and the closed-day rules; a different period is shown clearly in the confirmation. |
| G6 | Correction reason is mandatory (same limits as a void reason) and is stored on both records and in the audit log. |
| G7 | A correction is **idempotent**: it carries a client reference, so a double click cannot create two replacements. |
| G8 | An original can be corrected **at most once per chain link**: the replacement can itself be corrected later (new void + new replacement) and the history shows the chain. |
| G9 | Database protections (migrations 016, 019, 020, 021 triggers) are unchanged and still enforced; the new link column (below) does not weaken any of them. |

**How the link is stored (needs a migration, forward-only, existing rows untouched):** a nullable `corrects_id` on the replacement row of each supported table (a new migration 022). Originals are never modified (the only change to an original stays the existing guarded `posted → void` flip). Triggers ensure the linked original is void and of the same type; one replacement per original.

**How atomicity is achieved:** the void and create services currently each run their own transaction. The implementation refactors each into an inner function that works on an open connection (the service wrapper stays identical for normal use), and a `correct` function calls inner-void then inner-create inside one transaction. No behaviour of the existing endpoints changes; their tests stay as they are.

## 3. What can go wrong that is specific to corrections (and how it is handled)

- **Cost snapshot drift (sales, personal use):** the void puts stock back at the original value; the replacement is then costed at the weighted average **at that moment**. If other purchases happened in between, the replacement's automatic cost can differ slightly from the original's. This is consistent with the approved rule "costing follows posting order; no recalculation of earlier snapshots". The confirmation screen shows the automatic cost that will be used.
- **Rates that changed since (reloads, EZCash):** see section 4.7; needs an owner decision.
- **Stock already sold or used:** purchases and opening stock cannot be voided once their goods were sold; the correction is refused with the existing message.
- **Closed days:** the original's date must be open; if it is closed the owner must first use **Reopen day** (existing, audited). The correction never reopens a day.
- **Negative cash:** the void may take a book below zero; the existing warning (never a block) is shown after saving.

## 4. Transaction-by-transaction recommendation

Legend: **Phase 1** = recommended first release (simple, low risk). **Phase 2** = supported later after Phase 1 proves itself. **Not automatic** = keep the existing manual path (void, then enter a new record yourself). **Never** = a rule forbids it.

### 4.1 Sales (POS) — **Phase 1**
- Void guard today: day open; not already void; **no returns in force** (`HAS_RETURNS`).
- Correction = void sale + new sale with the revised lines, prices, cost, date.
- Eligible only when there are no posted returns. If it has returns the screen says: *"Void the returns first (newest first), or leave the sale as it is."*
- Watch-outs: cost drift (section 3); stock must cover the replacement (it does, because the void restored the goods); a mixed Shop + scratch-card cart is two sales, each corrected separately.

### 4.2 Sales returns — **Not automatic (Phase 2 at most)**
- Void guard (R-VR): newest return first; the returned units must still be in stock; closed-day rules; stock difference gain/sweep goes to Stock adjustments.
- A corrected return would chain two refusals-prone steps. The existing manual path (Void return, then Return items again) already works. Recommend **no Edit button** on returns for now; instead make the void-return screen offer a link "Enter the corrected return" after success. Revisit in Phase 2.

### 4.3 Purchases — **Phase 2**
- Void guard: no returns (`HAS_RETURNS`); all purchased units still on hand (`INSUFFICIENT_STOCK`); day open.
- Typical mistakes (wrong price/quantity) are exactly what owners want to correct, but the void is refused once any unit was sold, which is common. Correction is safe whenever the void is allowed; when refused, the screen explains how many units were already used.
- Watch-out: the replacement changes the weighted average from that point on; earlier sale snapshots stay (approved rule).

### 4.4 Purchase returns — **Never (no void exists)**
- There is no void of a purchase return in the approved design. No Edit.

### 4.5 Expenses — **Phase 1**
- Void guard: day open; Ice Cream book expenses use Payments (`USE_ICECREAM_PAYMENTS`); electricity rule unchanged on the replacement.
- No stock effect, no dependents: the simplest case.

### 4.6 Transfers between cash books — **Phase 1**
- Void reverses both legs on the transfer's date; both books' days must be open. Negative-cash warning only.
- Replacement is a normal transfer; the Ice Cream fund rules (D2/D4 splits for transfers involving that book) apply as for any new transfer.

### 4.7 Capital, cash drawings, goods drawings, cash counts
- **Capital entries — Phase 1** (cash only, no dependents).
- **Cash drawings — Phase 1.**
- **Goods drawings (personal use) — Phase 2:** stock effect and cost drift as sales.
- **Cash counts / over-short / daily closing adjustments — Not automatic**: a void of a count exists, but a count is a fact at a moment; correct a wrong count by **Reopen day** (audited) and recount, not by Edit.

### 4.8 Reloads, EZCash, top-ups — **Phase 2 (needs one decision)**
- Void guard: day open; negative-cash warning only.
- **Decision needed:** commission rates live in Settings and may have changed since the original was entered. For the replacement, should the commission be (a) at **today's rate** (what a new entry would get — simplest, but a correction could change the commission slightly), or (b) at the **rate stored on the original row** (each row already stores its own `commission_bp`; keeps the correction faithful, but the current create function takes the rate from Settings and would need a controlled way to receive it)? Recommendation: **(b) with the rate shown in the confirmation**, but this touches an approved calculation input and needs your explicit approval; until then reloads/EZCash stay manual (void, then re-enter).
- Provider/wallet **top-ups — Phase 1** (cash only, no commission).

### 4.8b Printing / Services — **Phase 2**
- Print and service sales: the void reverses the cash entry only (day open, R9); the price is typed by the cashier, so correction is straightforward. Eligible whenever the day is open.
- Printing supplies: **Phase 1** (cash only, no dependents).

### 4.9 Ice Cream records
- **Daily entries — already supported:** the approved rule C9 gives Ice Cream days "void-and-replace" (`PUT /icecream/days/:date`) under the D2 release guard (`VOID_BREAKS_RELEASE`: profit already released to the owner depends on it, reverse the release first). Recommendation: expose it consistently as the same "Edit" button and the same explanation text; no new accounting.
- **Payments — Phase 1:** the void only needs an open Ice Cream day (R9); it returns the money to its fund and has no other guard. The replacement is checked like any new payment (for example the fund must cover it, `NEGATIVE_FUND_BALANCE`, and the Electricity rule).
- **Fund moves — Phase 1:** the void has the D2 release guard (`VOID_BREAKS_RELEASE`); the replacement is checked like a new move (no negative funds).
- Any correction that would break released profit or push a fund negative is refused with the existing message.

### 4.10 Stock adjustments
- **Stock losses (write-offs) — Phase 1**, except losses that came from a **damaged sales return** (`DAMAGED_RETURN_LOSS`): those cannot be voided and therefore **never** support Edit (correct through the return).
- **Stocktakes — Not automatic.** A completed stocktake is a count at a moment; its void requires the added stock to be unused (`INSUFFICIENT_STOCK`). A mistaken count is corrected by a new stocktake, which is the intended, simpler workflow. Draft stocktakes are already editable (they have posted nothing).
- **Opening stock batches — Not automatic.** Go-live only; the void requires all units still on hand; a mistake after trading started is better handled by a purchase/adjustment you can see. Keep manual void and re-enter.

## 5. Summary table

| Transaction | Edit button? | Existing void guards that still decide | Notes |
|---|---|---|---|
| Sale (no returns) | **Phase 1** | R9 closed day, HAS_RETURNS | cost drift warning |
| Sales return | Not automatic | R-VR newest-first, stock available, R9 | manual two-step stays |
| Purchase | Phase 2 | HAS_RETURNS, INSUFFICIENT_STOCK, R9 | refused if goods sold |
| Purchase return | Never | no void exists | — |
| Expense | **Phase 1** | R9 | |
| Transfer | **Phase 1** | R9 on both books | |
| Capital / cash drawing | **Phase 1** | R9 | |
| Goods drawing | Phase 2 | R9, stock | cost drift |
| Cash count / closing | Not automatic | R9 | use Reopen day |
| Reload / EZCash | Phase 2 (decision on rate) | R9 | commission rate question |
| Top-up | **Phase 1** | R9 | |
| Print/service sale | Phase 2 | R9 | |
| Printing supplies | **Phase 1** | R9 | |
| Ice Cream day | Already (C9) | D2, R9 | unify the button |
| Ice Cream payment / fund move | **Phase 1** | R9 (moves also D2 release guard) | |
| Stock loss | **Phase 1** (not return-damage losses) | R9 | |
| Stocktake | Not automatic | stock used | recount instead |
| Opening stock batch | Not automatic | stock on hand | go-live only |

## 6. Screens

- History rows of supported types get **Edit** next to **Void**.
- Edit dialog = the normal entry form pre-filled + a banner with the explanation, the eligibility result and the correction reason field.
- Voided originals show a badge "Corrected by #456"; replacements show "Corrects #123 — reason".
- Reports are unchanged: a void changes nothing in reports (the existing rule), the replacement counts as a normal record.

## 7. Test plan (before merge)

- For every supported type: correction succeeds when the void would succeed; the resulting ledgers equal "manual void + manual create" to the cent; refusal paths (every guard above) leave the database **byte-for-byte unchanged**; double-click idempotency; concurrent correction of the same original; corrections across closed days refused; reconciliation (stock = Σ movements, cash book = Σ entries, Ice Cream funds) after random sequences of corrections against an independent model; migration test on a populated database (no historical row changes); raw-SQL attempts to link a replacement to a posted original or two replacements to one original are refused.
- No existing test is removed or weakened.

## 8. Decisions I need from you

1. Approve the Phase 1 list (sales without returns, expenses, transfers, capital, cash drawings, top-ups, printing supplies, Ice Cream payments and fund moves, stock losses) — yes / change.
2. Phase 2 types (purchases, goods drawings, print/service sales, reloads/EZCash): include now or later?
3. Reloads/EZCash commission on correction: today's rate, or the original's rate (recommended, needs your approval)?
4. Types you want **excluded**: returns, stocktakes, opening stock, cash counts (all recommended).
5. Default replacement date = original date (recommended) — confirm.
6. Migration 022 for the `corrects_id` link column — confirm.
