# Business Rules (authoritative)

Agents must not change these formulas. Proposed changes go to the orchestrator. Rule IDs R1–R14 come from the independent Financial Logic review (approved).

## 0. Fundamentals
- **Fresh start.** No historical workbook data is migrated. Go-live = opening stock + opening balance per cash book.
- **Cash only**, one physical drawer, three *logical* cash books: `shop`, `telecom`, `icecream`.
- **Money** is integer cents; **rates** are basis points; display `Rs. 12,345.00` (negative: `-Rs. 1,234.50`).
- **Rounding:** `mulDivRound(a, b, c) = round(a × b / c)`, computed exactly with BigInt, **half away from zero**. All derived money (removal values, commissions, proportional returns) uses this one helper. Inputs and results must be safe integers.
- **Segments are disjoint.** Every product, expense, loss, drawing, capital entry, cash entry belongs to exactly one book; Combined P&L = Shop + Telecom + Ice Cream.

## 1. Segments
| Segment | P&L | Cash in | Cash out |
|---|---|---|---|
| Shop | goods sales − goods COGS; print/photocopy/other services − service cost; − shop expenses (**never electricity**, §7) − stock adjustments (net) − cash over/short | goods & service sales, capital, transfers in | shop-goods purchases, printing supplies, shop expenses, cash drawings, refunds, transfers out |
| Telecom | reload commission + rounding extra; EZCash commission; scratch-card sales − card COGS; − telecom expenses (**never electricity**, §7) − stock adjustments (net) − cash over/short | full reload collections, full EZCash bill collections, card sales, capital, transfers in | provider top-ups, wallet top-ups, card purchases, telecom expenses, drawings, transfers out |
| Ice Cream | **recognized profit (§10):** Σ daily profit shares + profit-eligible releases − re-allocations − other costs paid from the Profit Fund ± cash over/short; ⚠ excess cost shown separately (§10.5) | daily sales, capital, transfers in | material payments, **the whole shop's electricity bill** (settlement), other payments, drawings, transfers out |

Below the line (never P&L): owner drawings (cash & goods), capital, transfers, opening balances, provider/wallet top-ups, inventory purchases, ice-cream settlements, printing supplies, ice-cream fund balances and Cost ↔ Electricity moves.

## 2. Cash entry types → book → P&L
| Type | Book | P&L effect |
|---|---|---|
| `sale_goods`, `sale_service`, `sale_refund` | shop | via sales / returns tables (revenue − cost) |
| `card_sale`, `card_refund` | telecom | via sales / returns tables |
| `reload_collection` | telecom | commission + extra only (from `reload_sales`) |
| `ezcash_collection` | telecom | commission only (from `ezcash_sales`) |
| `provider_topup`, `wallet_topup` | telecom | none |
| `purchase_payment`, `purchase_refund` | shop or telecom (by products) | none (stock only) |
| `expense`, `expense_refund` (reserved, never written: an expense void reverses the `expense` entry) | **shop or telecom only** (never icecream; category never electricity) | that segment's operating expenses |
| `icecream_sale` | icecream | revenue (from `icecream_days`) |
| `icecream_materials_payment`, `icecream_electricity_payment` | icecream (any fund) | none — settlements of the daily allocations; **never an expense in any segment** |
| `icecream_other_cost` | icecream (any fund) | from the Profit Fund → other ice-cream expense; from the Cost/Electricity fund → settlement (category never electricity) |
| `printing_supplies` | shop | none (variance report only) |
| `cash_adjustment` | any | cash over/short in that book's segment |
| `opening_balance`, `capital`, `drawing_cash`, `transfer_out`, `transfer_in` | any | none |

Every Ice Cream cash entry names exactly one fund (§10.2). Ice Cream fund moves create **no** cash entry; their profit effect is defined in §10.3.
Non-cash: goods drawing (no P&L) · stock loss / stocktake (Stock adjustments line of the product's segment) · opening stock (no P&L) · ice-cream fund moves (no cash; profit effect per §10.3).

## 3. Inventory & weighted-average costing
- Per product cache: `qty_on_hand`, `stock_value_cents`; average = value / qty (display only).
- **Inflows** add qty and exact value: opening stock (no cash, no purchase), purchase (line total), resalable sales return (original snapshot cost), stocktake gain (current average via `mulDivRound(value, gainQty, qty)` when the product has both quantity and value; if its quantity is 0 or its value is 0, an entered unit cost — see C10).
- **Outflows** remove `mulDivRound(value, q, qty)`; when `q = qty` remove the entire remaining value: sale, personal use, loss, stocktake loss.
- **Purchase return / void (R4):** remove min(purchase-cost value, pool value); if qty reaches 0 with residual value, sweep it via a value-only `adjustment` movement → Stock adjustments line. Return date ≥ original purchase date (R-RD, §12).
- Every change writes exactly one `stock_movements` row in the same transaction as the cache update. Invariant: SUM(movements) = cache, per product.
- **Blocked:** any outflow > qty on hand (message: "Not enough stock: 3 on hand, 5 needed."); negative quantities/prices.
- **Pack size:** units = packs × pack_size; value = exact line total (no per-unit rounding loss).
- **COGS snapshot:** stored on the sale line; later purchases never change it.
- Costing follows posting order; reports follow business date (R7).

## 4. Sales, returns, voids
- POS cart is split by product book into one sale per book (shop / telecom). Lines processed in cart order; qty checked per product across the whole cart (R13).
- **Voids (R1):** business document gets `status='void'`; ledger tables get **new reversal rows** (never edited/deleted). Balances sum all ledger rows; P&L reads only `status='posted'` business rows and never reads reversal rows. Void is blocked if returns exist.
- **Returns (R5, R7):** qty capped at sold − already returned; partial return value = `mulDivRound(lineTotal, q, lineQty)` except the final unit takes the remainder. Resalable → stock back at original snapshot cost. Damaged → revenue and COGS reversed + one `stock_losses` row at original cost (no restock, loss counted once). Returns hit the period of the return date. Return date ≥ original sale date (R-RD, §12).
- **Warnings, not blocks (R13):** price < min price, price < snapshot cost, service cost > price, qty > 0 with value 0, negative cash-book balance.

## 5. Telecom
- Reload (one or more entries per provider per day; providers Dialog, Mobitel, Hutch, Airtel): `commission = mulDivRound(sales, rateBp, 10000) + extra` (extra ≥ 0, default 0; rate snapshotted, default 600 bp; each provider may carry its own rate, otherwise the shop default applies). Telecom cash +sales. No reload stock, float, or balances.
- EZCash (under Dialog): `commission = mulDivRound(billTotal, rateBp, 10000)`, default 80 bp; it uses the shop-wide EZCash rate and does not depend on the provider's reload rate. Telecom cash +billTotal; wallet top-ups are cash-outs.
- Scratch cards: stock products in the Scratch Cards category (book `telecom`); normal stock sale with COGS.
- Example: 50,000 @ 600 bp + 50 extra → 3,050 commission; 50,000 @ 80 bp → 400.
- R14: Telecom cash book will not reconcile to Telecom profit (no float tracking — owner decision).

## 6. Printing (R12)
- Service types have configurable price and standard cost per page; sale snapshots cost; revenue − standard cost = gross profit.
- Paper/toner purchases = `printing_supplies` cash-out (no P&L); variance report = standard cost charged vs actual supplies spend.

## 7. Expenses & electricity (R10, P-2 approved 2026-11-10)
- `expenses` are **Shop or Telecom only**; the expense's book is its segment. Ice Cream costs never use `expenses` — they use the ice-cream records (§10).
- Expense categories: Water, Rent, Internet, Transport, Repairs, Cleaning supplies, Packaging, Stationery, Other. **There is no Electricity expense category.**
- **Electricity rule (owner, binding):**
  - **E1** The **entire shop electricity bill** is paid from the **Ice Cream** book.
  - **E2** Shop and Telecom electricity expenses are **blocked**: the API rejects them (`400 ELECTRICITY_NOT_ALLOWED`, "Electricity is paid from the Ice Cream book") and the database cannot store them (CHECK).
  - **E3** The **daily electricity allocation** in the ice-cream day entry (adjusted by §10.4 releases, re-allocations and Cost↔Electricity re-labels) is the **only** electricity P&L charge (Ice Cream segment).
  - **E4** Actual bill payments are **settlements** (`icecream_electricity_payment`) and are **never counted again as an expense** — in any segment, including as an ice-cream "other" expense (also blocked by category).
  - **E5** Reports: the Combined report shows an informational electricity line = Charged_Electricity for the period (memo: actual bills paid); it is never added to or deducted from any profit figure (C3).
- Purchases (R11) are always fully paid in cash from the book derived from their products; mixing shop and telecom products in one purchase is rejected ("split into two bills").

## 8. Cash books, transfers, closings
- Closing = opening + in − out (sum of ledger rows). Opening balance entered at go-live (`opening_balance`).
- Transfer = linked `transfer_out` + `transfer_in` with shared `transfer_id`, one DB transaction, no P&L; void reverses both. The Ice Cream side names a fund (§10.2).
- Cash count → expected vs counted; difference posted as `cash_adjustment` (note required) → "Cash over/short" line (R6).
- Daily closing per book per date; edits to a closed day require reopen (audited) and are made as reversal + new rows (R9).

## 9. Drawings & capital
- Cash drawing: cash-out from a chosen book (Ice Cream: and a chosen fund); no P&L.
- Goods drawing (personal use): stock removed at average cost; drawing recorded at cost; no revenue, no COGS, no expense.
- Capital and opening balances: cash-in; never revenue (Ice Cream: owner chooses the destination fund; never profit-eligible).

## 10. Ice Cream — three-fund system (R8; P-1 approved 2026-11-10 with D1–D4)
The Ice Cream cash book is divided into three **funds**: **Cost**, **Electricity**, **Profit**.

**10.1 Two separate measures — always shown side by side, never mixed**
- **Fund balances** = internal cash allocation of the Ice Cream cash book. **Cost + Electricity + Profit = Ice Cream cash book balance** (invariant, tested).
- **Recognized profit** = the official Ice Cream accounting profit. It changes **only** through the recognition events in 10.3. A fund balance is never income; an internal fund move is never revenue or an expense.

**10.2 Fund events (cash allocation)** — every Ice Cream cash movement names exactly one fund.
| Event | Fund effect | Cash book |
|---|---|---|
| Daily entry (sales S, cost C, electricity E) | Cost +C, Electricity +E, Profit +(S − C − E) | +S |
| Materials payment | − fund chosen by owner (default Cost) | −amount |
| Electricity bill payment — the whole shop's bill (E1) | − fund chosen by owner (default Electricity) | −amount |
| Other ice-cream cost (cups, repairs…) | − fund chosen by owner | −amount |
| Fund move A → B | A −x, B +x | none |
| Owner withdrawal (drawing) | − fund chosen by owner | −amount |
| Transfer to Shop / Telecom | − fund chosen by owner | −amount (other book +amount) |
| Opening balance / capital / transfer in | + fund chosen by owner | +amount |
| Cash over / short (C4) | ± fund chosen by owner (default Profit, C4) | ±amount |
Any fund may go **negative → clear warning**, never blocked. A daily entry writes **one `icecream_sale` cash entry per non-zero fund share** (Cost C, Electricity E, Profit S − C − E; the Profit share is negative only when confirmed), so every cash entry names exactly one fund and the three always sum to S.

**10.3 Recognition events — the only things that change recognized profit**
| Event | Recognized profit |
|---|---|
| Daily entry | **+(S − C − E)** (day's profit share; negative only with explicit confirmation) |
| Move Cost → Profit or Electricity → Profit (*release*) | **+ profit-eligible part** (10.4); any excess moves as cash only (D4) |
| Move Profit → Cost or Profit → Electricity (*re-allocation*) | **− the full amount** (D1) |
| Other ice-cream cost paid **from the Profit Fund** | **− amount** |
| Cash over / short | + over / − short |
| Move Cost ↔ Electricity | **0** (re-labels the charge between lines, 10.4) |
| Materials or electricity payment (any fund); other cost paid from the Cost or Electricity fund | **0** — settlement of allocations already charged (E4) |
| Withdrawal or transfer out of **any** fund (incl. Profit) | **0** — earned profit is never reduced by taking the cash |
| Opening balance, capital, transfer in | **0** |

**10.4 Exactly-once guard**
Per line L ∈ {Materials (Cost fund), Electricity}:
- *Charged_L* = daily allocations to L + re-allocations into L ± Cost↔Electricity re-labels − profit-eligible releases from L.
- *Settled_L* = payments attributed to L: materials payments → Materials; electricity bill payments → Electricity; other costs paid from the Cost fund → Materials, from the Electricity fund → Electricity. Materials/electricity payments made from the Profit fund still count to their own line (settlements, never expenses).
  - **Confirmed 2026-11-10:** an other cost paid from the Cost or Electricity fund **reduces that fund's available allocation** (Unspent_L) and is **never** a separate P&L expense — it is already covered by the daily allocation. If it exceeds the available allocation, the shortfall appears only as *excess cost not yet charged* (10.5), never as an expense, so it cannot be counted twice.
- *Unspent_L* = Charged_L − Settled_L; combined *Unspent* = Σ lines.
- **Profit-eligible limit** for a move L → Profit = **min(max(0, Unspent_L), max(0, Unspent))**. Opening balances, capital, transfers-in and money already spent can therefore never become profit, and nothing is recognized twice.
- **D4 — split with confirmation:** if a move into Profit exceeds the limit, the server does not post it; it answers with the split — *profit-eligible amount* (increases recognized profit) and *cash-only amount* (moves the cash, no profit effect) — and a plain-language explanation (e.g. "Rs 5,000 of this is opening/capital/already-spent money and will not count as profit"). Only when the owner confirms is the move posted, as **one** atomic record with both parts.
- **Cost ↔ Electricity move of x:** the cash always moves; the charge re-label = **min(x, max(0, Unspent_source))**. Profit unchanged.
- **D2 — void guard:** voiding a daily entry (incl. void-and-replace, judged on the final state), a re-allocation, or a Cost↔Electricity move is **blocked** (`VOID_BREAKS_RELEASE`, "profit already released depends on this — reverse the release first") **only if the void lowers some Charged_L or the combined Unspent AND the resulting state has any Charged_L < 0, or net releases > 0 while combined Unspent < 0**. *Net releases* = Σ profit-eligible releases − Σ re-allocations. Voids of releases and of payments only loosen the limits and are always allowed. (The guard covers these three record types because each can be what a release depends on — same principle as D2.)
- **Identity (proven in review):** recognized profit − true profit = −Unspent. When Unspent = 0, recognized profit = sales − actual materials − actual electricity − other costs ± over/short.

**10.5 D3 — excess cost (official figure stays allocation-based)**
- If combined Unspent < 0, real spending has exceeded the allocations: **Outstanding excess cost = −Unspent** (a balance at a date). The report line *Excess cost not yet charged* is the **change** in this balance during the report period (10.6). **Naming rule:** "Excess cost not yet charged" always means the period change; a balance at a date is always "outstanding excess cost".
- Official profit is **never** reduced automatically. Every relevant report — daily, monthly, Ice Cream P&L, fund statement, dashboard and the **Combined P&L** — shows, whenever excess cost exists, a clear warning plus the three lines defined in 10.6: **Recognized profit**, **Excess cost not yet charged**, **Profit after excess cost**.
- It shrinks as later daily allocations are charged and is cleared by the owner's re-allocation from the Profit Fund (10.3), which charges it.

**10.6 Ice Cream P&L**
```
Sales                                     Σ S
− Materials (allocated)                   Charged_Materials
− Electricity (allocated) — whole shop    Charged_Electricity
− Other ice-cream expenses                other costs paid from the Profit Fund
± Cash over / short
= Recognized Ice Cream profit   (official)
Recognition view: daily profit shares + profit-eligible releases − re-allocations − other expenses ± over/short (same total)
Memo: actual materials paid · actual electricity paid · other costs paid from Cost/Electricity funds ·
      unspent allocation per line · ⚠ outstanding excess cost (balance at period end)
```
**Period rule (confirmed 2026-11-10).** Every report row (a day, a month, any selected period) is calculated **only from the movements whose business date falls inside that period**:
- **Recognized profit** = recognition events (10.3) dated in the period.
- **Excess cost not yet charged** = the **change** in uncovered excess during the period = excess at period end − excess at period start (positive when new excess arose, negative when excess was covered or absorbed by later allocations).
- **Profit after excess cost** = recognized profit − excess cost not yet charged (both for the period).
- These three are pure flows: daily rows add up exactly to the month, months to the year. Excess that arose earlier is never deducted again; covering it later (a Profit → Cost/Electricity re-allocation lowers recognized profit and lowers the excess by the same amount) nets to zero, so nothing is double-counted.
- The **outstanding** excess at the end of the period is shown in the warning text only ("Rs X excess cost outstanding as of <date>"); balances (fund balances, Charged/Settled/Unspent, outstanding excess) are as of period end and are **never summed**.
- Excess at a date = max(0, −Unspent) computed from all events with business date ≤ that date.
- In reports, the Materials and Electricity charge lines are the **movements of Charged_L dated inside the period** (allocations, re-allocations, re-labels, profit-eligible releases); Charged_L itself is a cumulative balance.
- A negative *Excess cost not yet charged* is shown as **"−Rs X (earlier excess now covered)"** — the add-back of an excess deducted in an earlier period. Over any span: profit after excess cost = recognized profit − (outstanding excess at end − outstanding excess at start).
- `asOf`, `from` and `to` in every report are **business dates**.
- **Ordering (confirmed):** profit-eligible limits, D4 splits and the D2 void guard follow the **actual saving order** (posting timestamp). Reports follow the **business date**. See §12 for the record-keeping of both.

**10.7 Integrity**
- Every fund movement (allocation, payment, move, withdrawal, transfer, opening, capital, over/short) writes, in **one database transaction**: the business record, its fund-ledger row(s), its Ice Cream cash-book entry (if cash moves) and an audit-log entry. A move writes two fund-ledger rows and no cash entry.
- Fund ledger and cash book are append-only; voids are reversal rows (R1); closed days need reopen (R9); `clientRef` prevents duplicate submission (and so duplicate recognition).
- C2 (`icecream_cost_adjustment`) is **superseded**: a true-up is a fund move.

**10.8 Worked example (one month, Rs)**
Sales 100,000 split Cost 60,000 / Electricity 10,000 / Profit 30,000 · opening balance 5,000 → Cost fund · materials 55,000 (Cost) · electricity bill 12,000 (Electricity) · move Cost → Electricity 2,000 · move Cost → Profit 3,000 · cups 1,000 (Profit fund) · withdrawal 20,000 (Profit) · transfer to Shop 5,000 (Profit).
| Step | Cost fund | Elec fund | Profit fund | Charged M / E | Settled M / E | Recognized profit |
|---|---|---|---|---|---|---|
| Opening 5,000 → Cost | 5,000 | 0 | 0 | 0 / 0 | 0 / 0 | 0 |
| Daily entries | 65,000 | 10,000 | 30,000 | 60,000 / 10,000 | 0 / 0 | 30,000 |
| Materials 55,000 | 10,000 | 10,000 | 30,000 | 60,000 / 10,000 | 55,000 / 0 | 30,000 |
| Bill 12,000 | 10,000 | −2,000 ⚠ | 30,000 | 60,000 / 10,000 | 55,000 / 12,000 | 30,000 (Elec fund ⚠ negative; combined unspent 3,000 → no excess cost) |
| Cost → Elec 2,000 (re-label 2,000) | 8,000 | 0 | 30,000 | 58,000 / 12,000 | 55,000 / 12,000 | 30,000 |
| Cost → Profit 3,000 (eligible 3,000) | 5,000 | 0 | 33,000 | 55,000 / 12,000 | 55,000 / 12,000 | **33,000** |
| Cups 1,000 from Profit | 5,000 | 0 | 32,000 | 55,000 / 12,000 | 55,000 / 12,000 | **32,000** |
| Withdrawal 20,000 + transfer 5,000 | 5,000 | 0 | 7,000 | — | — | 32,000 (unchanged) |
- Fund total 12,000 = cash book (5,000 + 100,000 − 55,000 − 12,000 − 1,000 − 20,000 − 5,000) ✓.
- P&L: 100,000 − 55,000 − 12,000 − 1,000 = **32,000** = true profit ✓.
- D4: moving the last 5,000 Cost → Profit → split shown: profit-eligible **0**, cash-only **5,000** (it is the opening balance); after confirmation the cash moves and profit stays 32,000.
- D3: had the bill been 20,000 with no re-allocation, combined Unspent = −5,000 → reports show ⚠ "Excess cost outstanding: Rs 5,000" and, for the period in which it arose, "Excess cost not yet charged: +Rs 5,000" and "Profit after excess cost" = recognized − 5,000; official profit unchanged until the owner re-allocates.

## 11. Stock losses & adjustments (R2, R3)
- Losses (damaged / lost / expired / other) remove at average cost; book = product's book.
- P&L line per segment: **Stock adjustments (net) = losses + stocktake losses + residual sweeps − stocktake gains − purchase refund gain**.
- **Purchase refund gain (R4, made explicit in Phase 14 — it was the documented intent, found missing from the reports by the independent QA pass):** when a purchase is returned or voided, the supplier refunds the full purchase value in cash but only min(purchase-cost value, pool value) leaves stock. When the pool value is lower than the purchase cost (the average cost fell after a cheaper purchase) the difference `refund − value removed from stock` is a real gain; it is shown as its own line ("Purchase refund above stock value removed") and reduces Stock adjustments (net), so segment profit reconciles with cash + stock. A return puts the gain in the return's period; a void puts it in the original purchase's period (R1). The residual sweep (pool value above cost) and this gain cannot both arise on one line.

## 12. Audit & integrity
- Audit log for every edit, void, reopen, restore, settings change (before/after JSON).
- No hard deletes of completed transactions. Duplicate submissions prevented by `clientRef`.
- **Business date vs posting time (confirmed 2026-11-10):** every financial record stores both its **business date** (entered by the owner; drives all reports and periods) and its **posting timestamp** `posted_at` (set by the server when saved, UTC, never editable; drives posting order — profit-eligible limits, D4 splits, D2 void guard, weighted-average costing). Every audit entry records both. An entry is **backdated** when its business date is earlier than the posting date in Asia/Colombo; backdated entries are flagged in their audit entry and listed in a *Backdated entries* report, so backdated corrections can always be traced.
- **No future-dated transactions (owner rule R-FD, approved 2026-11-10):** no financial record may have a business date later than **today in Asia/Colombo** (UTC+5:30, no daylight saving). **Backdated entries remain allowed** (and are audited as above). The **server** enforces this on every financial write — the frontend date pickers (max = today) are a convenience only — and rejects with the message **"Future-dated transactions are not allowed. Please select today or an earlier date."** (error code `FUTURE_DATE_NOT_ALLOWED`; also enforced by database triggers, DATABASE_SCHEMA). It applies to every record that carries a business date: sales and sales returns, purchases and purchase returns, opening stock, stocktakes, stock losses, goods drawings, reload and EZCash entries, provider/wallet top-ups, printing supplies, expenses, cash-book opening balances, capital, cash drawings, transfers, cash counts and over/short, daily closings, Ice Cream days (incl. the replacement row of a void-and-replace), payments and fund moves, opening-stock import rows, and the ledger rows derived from all of these (stock movements, cash entries, Ice Cream fund entries). Reversal rows keep the original business date (never later than today), so voids are unaffected; reopening a closed day carries no business date and is unaffected. The posting timestamp is always set by the server and can never be supplied or edited by the user. **Scope:** R-FD applies to transactions only — report and query dates (`asOf`, `from`, `to`) are never rejected; a date after today simply shows the same figures as today, because nothing can be dated later.
- **Returns not dated before the original (owner rule R-RD, approved 2026-11-10):** a **sales return** may not have a business date earlier than its original sale's business date, and a **purchase return** may not have a business date earlier than its original purchase's business date. A return dated **on or after** the original date is allowed — including backdated returns (audited as backdated) — and R-FD still caps it at today, so the valid window is *original date ≤ return date ≤ today*. Enforced by the **server** and by **database triggers**; the message names the original date: **"The return date cannot be earlier than the original {type} date ({date}). Please select {date} or a later date (not after today)."** (error code `RETURN_BEFORE_ORIGINAL_DATE`). It applies to every return, full or partial, judged against the original document's business date (each partial return independently; partial returns may be in any order among themselves). Unchanged: partial-return quantities and values (R5, C5, C7), returns hit the period of their own date (R7), no return on a voided document and no void of a document that has returns (R1), closed days (R9), future dates (R-FD). A damaged sales return's stock-loss row uses the return's date, so it also satisfies the rule. A purchase-return residual sweep (R4) carries the return's business date; the sweep of a purchase void carries the voided purchase's business date; both are ≥ the original purchase date and ≤ today. Original sales and purchases can never have their business date changed after posting (correction = void-and-replace), so an existing return can never come to precede its original.
- **Reversals:** a reversal row copies the **business date** of the row it reverses (so the correction lands in the same report period); its **posting timestamp** is the time of the void; the voided document's `voided_at` = that posting timestamp. The audit entry of the void records both.
- **Audit columns:** from Phase 3 (the first financial records) every audit entry for a financial record carries `business_date` and `backdated` as columns (migration 004, see DATABASE_SCHEMA); non-financial entries (settings, backups) have `business_date` NULL.

## 13. Clarifications (Phase 1 Financial Logic review, accepted by orchestrator)
These complete rules above; they introduce no new owner decisions.
- **C1 Electricity, ice cream side** (now consolidated in §7 E1–E5): the Electricity category is also blocked for `icecream_other_cost`; electricity leaves the Ice Cream book only as `icecream_electricity_payment` (settlement). The `expense`/`expense_refund` types are Shop/Telecom only; Ice Cream uses its own types (§2).
- **C2** — **REMOVED** (superseded by §10 fund moves; a true-up is a re-allocation or a release).
- **C3 Consequence note:** by owner rule the Ice Cream P&L bears the whole shop's electricity; Shop and Telecom carry none. The Combined report shows electricity as an informational line.
- **C4 Cash over/short sign:** difference = counted − expected (Ice Cream: the owner selects the fund each time — **default Profit**; profit treatment: over = +, short = −; it never changes Charged/Settled/Unspent; every adjustment is audited). Positive → `cash_adjustment` cash-in, P&L "cash over" (income). Negative → cash-out, P&L "cash short" (cost).
- **C5 Partial returns:** both revenue and COGS use `mulDivRound(lineAmount, q, lineQty)`; the return that brings cumulative returned qty to the full line qty takes the exact remainder for both.
- **C6 Void reversals:** voiding a sale, goods drawing, loss or stocktake writes ledger rows that are the exact negation of the original movement(s)/cash entries (same value, same unit cost), so stock returns at the original snapshot value.
- **C7 Partial purchase return value:** `mulDivRound(lineTotal, q, lineUnits)`, with the remaining line value when q = all not-yet-returned units; then min against the pool (R4).
- **C8 Type lists:** §2 is the authoritative cash-entry type list; §1's in/out columns are a summary.
- **C9 Voids everywhere:** every business record (reload/EZCash entries, top-ups, expenses, drawings, capital, losses, transfers, ice cream payments and fund moves) can be voided via reversal rows (R1) unless dependents block it. Ice cream day edits = void-and-replace (fund, cash and audit entries) subject to the §10.4 void guard; closed days need reopen first (R9).
- **C10 Stocktake gain at zero value:** if qty = 0 **or** value = 0, the gain uses an entered unit cost (required); otherwise current average.
- **C11 Rate validation:** every rate in bp must satisfy 0 ≤ rateBp ≤ 10000; extras ≥ 0.
- **C12 Selling price:** never derived from average cost; it is an owner-maintained product field.

- **C13 Extra cost on a sale (owner rule, 2026-11-11):** when a sale line is recorded, the **cost (COGS) fills in automatically** at the weighted-average value removed from stock (§3). The cashier **may raise the cost per unit but never lower it** below the automatic cost (e.g. automatic Rs 37.40 → entered Rs 38.00). The line's **cost charged** = quantity × entered unit cost; the part above the automatic cost is the line's **extra cost** (here Rs 0.60 per unit), kept as its own figure under cost and **included whenever cost is calculated**.
  - **Stock is unaffected:** it leaves at the true weighted-average value, so stock quantity/value and reconciliation stay exact. The extra cost creates **no stock movement, no cash entry and no separate balance**; it is money already in the book's cash that the owner may later use to buy products.
  - **Profit uses the cost charged:** line gross profit = revenue − (automatic cost + extra cost). The extra is part of the cost of sales for the period, shown separately ("Cost: automatic Rs X + extra Rs Y").
  - **Returns and voids (C5/C6):** a return reverses the extra cost in proportion (the same exact-remainder split as revenue and automatic cost, the final return takes the remainder) together with the automatic cost; a void removes the whole sale including its extra. Resalable returns restore stock at the **automatic** snapshot cost only; a damaged return's stock-loss row is the automatic cost only (the extra is just reversed from cost of sales).
  - **Default:** if the cashier leaves the cost as filled in, the extra cost is 0 and behaviour is exactly as before (§3, §4). Supersedes the earlier "COGS is always automatic" wording for the *sale screen only*; costing of stock itself remains automatic.

## 13A. Implementation decisions awaiting owner confirmation (recorded 2026-11-12, Phase 14 review)
These behaviours were chosen by implementers to complete approved rules. **None changes a formula, and none is an approved business rule until the owner confirms it.** They are listed so nothing is hidden.
1. **One opening balance per cash book** (per fund for Ice Cream) may be posted at a time; a wrong one is voided and entered again. Later money from the owner is capital (§8, §9).
2. **Expected cash** for a count or closing = the book's ledger balance of all entries with business date on or before the count date (backdated entries made later change what the same count would have expected). **A day may be closed without a count.** Reopening needs a reason of at least 3 characters.
3. **Per-provider reload rate** (§5) may differ from the shop default; EZCash always uses the shop-wide rate. An inactive provider blocks reload sales and provider top-ups but not EZCash.
4. **Stocktake:** a draft holds counted quantities; completion compares against the live quantity at completion time.
5. **Opening stock:** inactive and service products refused; a batch cannot be voided once its stock was sold or used; an Excel file already imported cannot be imported again while its batch is posted; all-or-nothing import (max 5 MB, 5,000 rows).
6. **Inactive products** cannot be sold or purchased; stock losses may still be recorded for them.
7. **Service-kind products cannot be sold in the POS.** "Other services" are sold through a print service type (for example CUSTOM) in the Printing screen. Print sales may change the unit price per job; the cost is always the type's standard cost (the C13 editable cost applies to POS stock sales only).
8. **Damaged-return losses** cannot be voided on their own, and a sale with returns cannot be voided, so a return is permanent.
9. **A purchase line may have value 0** (no cash entry is written for a total of 0).
10. **No limit on how far back** a business date may go (only R-FD caps the future); backdated entries are flagged and listed in the Backdated report.
11. **Backups:** one at every start-up and on request (newest 30 kept); a safety copy before every restore (newest 10 kept); the dashboard marks the newest backup "stale" after 48 hours.
12. **Dashboard and report definitions:** "Sales" = Shop goods + print revenue net of returns; Telecom scratch-card revenue + reload commission + EZCash commission (collections are not sales); Ice Cream daily sales; Combined = sum (can be negative in a month with more returns than sales). Low stock = active stock product with reorder level above 0 and quantity at or below it. "Days not yet closed" = the 7 days before the dashboard date, from the book's first cash entry on. Valuation as of a past date = movements dated up to that date (a backdated loss can make an earlier date negative; the report warns).
13. **Limits:** amounts up to 10^12 cents, quantities 10^6–10^9, 100 lines per sale or purchase, 1,000 per manual opening-stock entry, 500 per stocktake, 200 Ice Cream item lines, 3,660 days per report.
14. **Negative-cash warning (R13)** is returned by every write that removes cash from a book and by voids of cash-in records (including voids of sales, print sales, reload and EZCash sales — added in Phase 14).

## 13B. Category management (owner request 2026-11-13)
- Categories are created, renamed and deactivated by the owner in the app (Products → Categories). Each belongs to **Shop or Telecom**; the name is unique **within its book**, ignoring letter case (the same name may exist in both books). Categories are never deleted (deactivate instead). A default category keeps its name and book. A category's book cannot change once it has products. Renaming never moves products. Inactive categories are not offered for new products.
- A product's book is always its category's book (§1, unchanged). Category-first product selection (book → category → product) in Sales, Purchases, Opening Stock and stock-loss/personal-use entry is a selection aid only: **no accounting behaviour changed**.

## 14. Owner decisions log (Phase 1 final review)

### P-2 Electricity documentation — **APPROVED 2026-11-10, applied** (§1, §2, §7 E1–E5, DATABASE_SCHEMA, API_CONTRACTS).

### P-1 Ice Cream three-fund system — **APPROVED 2026-11-10, applied as §10** (rev. 2 after the independent Financial Logic review)
- **D1** approved: Profit → Cost/Electricity reduces recognized profit by the full amount.
- **D2** approved: voids that would leave released profit unbacked are blocked until the release is reversed (§10.4); the guard applies to daily entries, re-allocations and Cost↔Electricity moves — the record types a release can depend on.
- **D3** option A: official profit stays allocation-based; every relevant report incl. Combined shows a warning, "Excess cost not yet charged" and "Profit after excess cost" (§10.5).
- **D4** option A: moves into Profit beyond the limit are split into profit-eligible and cash-only parts, explained and posted only after owner confirmation (§10.4).
- Opening balance and capital: owner selects the destination fund each time.
- **Final confirmations (2026-11-10):** (1) report rows use only the movements inside the period — recognized profit, change in excess cost not yet charged, profit after excess cost; no cumulative balances summed (§10.6); (2) other costs from the Cost/Electricity fund reduce that fund's available allocation, never a separate expense (§10.4); (3) cash over/short default fund Profit, owner may choose another, audited (C4); (4) limits follow saving order, reports follow business date, both recorded and audited (§12).

### R-FD Future-dated entries — **APPROVED 2026-11-10** (owner: "YES – BLOCK"), applied in §12, DATABASE_SCHEMA and API_CONTRACTS.

### R-RD Returns not dated before the original — **APPROVED 2026-11-10** (owner: "YES – APPROVED"), applied in §3, §4, §12, DATABASE_SCHEMA and API_CONTRACTS.
