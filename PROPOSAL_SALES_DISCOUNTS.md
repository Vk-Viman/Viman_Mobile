# Sales discounts: FINAL APPROVED DESIGN (Shop products only, typed in rupees)

**Status: DESIGN APPROVED by the owner (2026-11-17), NOT IMPLEMENTED.** Approval of this document is not authorization to build: implementation waits for the owner's separate instruction. This file replaces versions 1 to 3. The accounting rules are recorded in `BUSINESS_RULES.md` section 13C.

Amounts are Sri Lankan rupees; the program stores integer cents (Rs 74.07 = 7,407 cents). `mulDivRound` is the existing exact integer rounding helper (BUSINESS_RULES section 0).

---

## 1. Every decision (all approved, none outstanding)

| # | Decision |
|---|---|
| 1 | Discounts are entered manually in LKR at the time of the sale. |
| 2 | Only fixed LKR amounts. No percentages. |
| 3 | A per-item discount is typed **per unit**. |
| 4 | Total line discount = discount per unit x quantity. |
| 5 | A whole-bill discount applies only to the **Shop subtotal**. |
| 6 | Telecom products never receive a discount (all scratch cards and every Dialog, Mobitel, Airtel and Hutch product, in all eight Telecom segments). |
| 7 | Telecom prices stay editable, but a Telecom price change is never recorded as a discount. |
| 8 | A Shop selling price typed below the product's normal list price is automatically recorded as a **price reduction**. |
| 9 | Whole-bill discounts are allocated with the **largest-remainder** method. |
| 10 | No predefined discount limits, no confirmation thresholds, no authorization steps. The only refusal is arithmetic (a discount cannot exceed the amount it is taken from). |
| 11 | Discounts reduce revenue, never COGS. |
| 12 | C13 extra cost is unchanged. |
| 13 | Partial returns refund the actual discounted amount paid. |
| 14 | Stock valuation, cash books, Telecom segments, voids, returns and correction rules stay intact. |
| **5 (warnings)** | Below-minimum-price and below-cost warnings are judged on the **final net effective unit price** after all Shop discounts; they never block; Telecom keeps its existing rules. **APPROVED.** |
| **6 (reports)** | Shop reports show Gross Sales, Discounts (Price Reductions, Per-unit Line Discounts, Whole-bill Discounts) and Net Sales; Net Sales reconciles exactly with the existing Shop sales revenue; Telecom reports have no discounts (always zero); included in the Shop P&L, operational reports, dashboard and Excel exports; voided sales excluded; profit calculations unchanged. **APPROVED.** |
| **7 (migration)** | One forward-only migration, **027** (the next free number after the Telecom segment migrations 024 to 026), rebuilding `sale_items` under the mandatory requirements of section 8. **APPROVED in principle** subject to those requirements. |

## 2. Where discounts exist (scope)

- **Exists:** goods lines of **Shop POS sales** (`sales.book = 'shop'`, segment NULL).
- **Never:** any Telecom sale or line (book `telecom`, any segment), Ice Cream records, print/service sales (Services screen), reloads, EZCash, top-ups, purchases, expenses and every other record. (Print/service sales are sold from the Services screen and are not POS goods lines; see risk 5.)
- A cart with Shop and Telecom lines is saved as today: one Shop sale plus one Telecom sale per provider (Telecom segments, BUSINESS_RULES 13D). Discounts are computed from the Shop lines only; **no part of any discount goes to Telecom**; the Telecom sales and their cash entries (each in its own segment) are exactly what they would be without the discount feature.
- A cart containing only Telecom products offers no discount fields; the server also refuses any discount sent for a Telecom line (`DISCOUNT_NOT_ALLOWED`).

## 3. The rules and formulas (final)

For one **Shop** sale line: `qty` units, product list price `L` (the product's normal selling price when the sale is made), typed selling price `P` (default `L`), typed discount per unit `d` (default 0), allocated whole-bill share `s_i` (default 0).

```
charged unit price   P                                       (what is typed in the price field; default = L)
gross                G  = qty x max(L, P)                    (what the line would be at its normal price; a price above L is an ordinary higher price)
price reduction      PR = qty x max(0, L - P)                (recorded automatically, decision 8)
line discount        LD = d x qty                            (decisions 3 and 4)
line amount          A  = qty x P - LD                       (the line after its own discount; basis of the allocation)
bill share           s  = largest-remainder share of the typed bill discount B (section 4)
net revenue          N  = A - s  =  qty x P - LD - s         (= revenue_cents: the amount paid; goes to the cash book)
discount (total)     D  = PR + LD + s
identity             G - D = N        (true for every line, also when P > L)
```
For every **Telecom** line: `L = P`, `PR = LD = s = 0`, `N = qty x P` exactly as today (a typed Telecom price is simply the price, decision 7).
Sale total (cash in) = sum of the lines' net revenue; for a Shop sale the `sale_goods` cash entry equals that total (no entry when it is 0, the existing free-sale behaviour).
**Profit** = net revenue - COGS - C13 extra cost. COGS and extra cost are the existing figures and are never changed by a discount (decisions 11 and 12): `COGS` = weighted-average cost removed from stock; `extra = (entered unit cost - automatic unit cost) x qty`.
**Historical sales** have `L = P`, `d = 0`, `s = 0`, so `PR = LD = s = D = 0`, `G = N = revenue_cents`: nothing is recalculated and no reported number changes.

**Limits (arithmetic only, decision 10):** `0 <= d <= P` per unit; `0 <= B <= S` where `S` = sum of the Shop lines' amounts `A` (the Shop subtotal after the per-unit discounts, never the whole cart); otherwise `DISCOUNT_EXCEEDS_AMOUNT` ("A discount cannot be larger than the amount it is taken from"). Equal to the whole amount is allowed (a free line or free Shop bill).

## 4. Whole-bill discount: largest-remainder allocation (approved)

The typed bill amount `B` (cents) is split over the **Shop lines** in proportion to each line's amount `A_i` (line amount after its per-unit discount); `S = sum A_i`:
1. `exact_i = B x A_i / S` (exact integer arithmetic).
2. `floor_i = floor(exact_i)`.
3. `leftover = B - sum floor_i` (between 0 and the number of Shop lines minus 1 cents).
4. Give one extra cent to each of the `leftover` lines with the **largest fractional remainder** (`exact_i - floor_i`); ties go to the earlier line (lower line number).
Properties (tested): the shares add up to exactly `B`; no line receives more than its own amount (a line only gets the extra cent when its exact share is not a whole number, so `floor + 1 <= exact <= A_i`); deterministic. If `S = 0` then `B` must be 0.

## 5. Warnings (decision 5, approved)

For each Shop line the existing advisory warnings are judged on the **final net effective unit price** `N / qty` (after the price reduction, the per-unit discount and the line's whole-bill share). To avoid rounding, the comparison is on the line:
- `PRICE_BELOW_MINIMUM` when `N < qty x (product's minimum selling price)`.
- `PRICE_BELOW_COST` when `N < qty x (unit cost the existing warning uses today: the charged unit cost of the line)`.
Warnings **never block** the sale (R13). Telecom lines keep the existing Telecom behaviour: the warning compares the typed unit price with the minimum price and the cost exactly as today (there is no discount to subtract). The screen shows the final net unit price next to the warning.

## 6. Returns, voids, corrections (decisions 13 and 14)

- **Partial returns:** the existing C5 formula applied to the amount actually paid: `refund for q units = mulDivRound(N, q, qty)`; the return that brings the returned quantity to the whole line takes the exact remainder; automatic cost and C13 extra cost reverse in proportion exactly as today; resalable stock returns at the original automatic cost; a damaged return reverses revenue and cost and records the loss once, as today.
- **Voids** of a sale reverse the net `sale_goods` cash entry and the stock movements exactly as today (same date, linked reversal rows, same Shop scope); the discount columns stay on the voided sale; a voided sale contributes to **no** report (gross, discounts and net all exclude it). Void of a return (R-VR), closed days (R9, per scope), backdating order, R-FD, stock movements and the append-only ledgers are unchanged.
- **Corrections ("correct this entry"):** the replacement body of a Shop sale carries the same discount fields (per-unit discounts, typed price, bill discount) validated by the same rules; the comparison table additionally shows discount and net revenue of original versus replacement; atomicity, guards and segment rules are unchanged.
- **Telecom segments:** a Shop sale has segment NULL; the Telecom sales of the same checkout carry their segments and their discount columns are all zero; the Shop and Telecom cash entries stay in their own cash books and segments; per-segment balances, closings and the Telecom total are unaffected.

## 7. Reports (decision 6, approved)

Shop only. Presentation of existing figures plus new read-only lines; no profit formula changes:
```
Gross Sales                          sum of G over posted Shop sales dated in the period
Discounts                            sum of D
   Price Reductions                  sum of PR
   Per-unit Line Discounts           sum of LD
   Whole-bill Discounts              sum of s
Net Sales                            sum of N          = the existing Shop sales revenue
```
- **Reconciliation (mandatory test):** for every period `Gross - Discounts = Net Sales`, and `Net Sales` equals the existing Shop goods-sales revenue line to the cent (the figure the Shop P&L, cash-book totals and dashboard already show). Returns remain a separate line dated by the return (R7) exactly as today; they reduce revenue by the net amounts refunded.
- **Where:** Shop P&L (informational lines under sales), the Sales operational report (columns and a Discounts report by date, product and category), the dashboard (Shop discounts for today/this month), and the Excel exports (new rows in the Shop P&L and Sales sheets, a Discounts sheet in the export pack).
- **Excluded:** voided sales; Telecom reports (they carry no discount lines and the Telecom segment blocks show zero); Combined P&L totals are unchanged in meaning.

## 8. Migration 027 (decision 7): mandatory requirements

Forward-only, never editing an earlier migration, next free number **027**. It rebuilds `sale_items` (the `CHECK (revenue_cents = qty * unit_price_cents)` has to change) using the proven pattern of 015, 023 and 025: `PRAGMA defer_foreign_keys = ON`, copy the rows to a TEMP table, keep the `sqlite_sequence` value, `DROP TABLE`, `CREATE TABLE`, re-insert with the **same ids**, restore the sequence, re-create every index and trigger, then guards that **abort the migration** if any row differs, a foreign-key violation remains, or the object set is not exactly the old set plus the new objects.
- **New columns:** `list_unit_price_cents` (existing rows: = `unit_price_cents`), `unit_discount_cents` (typed per unit, existing rows 0), `line_discount_cents` (= unit x qty, existing rows 0), `price_reduction_cents` (existing rows 0), `bill_discount_share_cents` (existing rows 0).
- **New checks:** `revenue_cents = qty x unit_price_cents - line_discount_cents - bill_discount_share_cents`; `0 <= unit_discount_cents <= unit_price_cents`; `line_discount_cents = unit_discount_cents x qty`; `price_reduction_cents = qty x max(0, list - unit_price)`; `revenue_cents >= 0`; all discount columns >= 0. The existing check `returned_qty BETWEEN 0 AND qty` and `line_type`, `UNIQUE (sale_id, line_no)` stay.
- **Telecom protection in the database:** a BEFORE INSERT trigger on `sale_items` (and the immutability trigger below) refuse any non-zero `unit_discount_cents`, `line_discount_cents`, `price_reduction_cents` or `bill_discount_share_cents`, and any `list_unit_price_cents <> unit_price_cents`, when the owning sale has `book = 'telecom'` (every segment); a raw-SQL attempt must be refused.
- **Historical data:** every existing sale line gets zero discount; revenue, COGS, extra cost, returned quantities, `sales.total_cents`, cash entries, stock movements, returns and their cash/stock effects are **identical before and after** (tested table by table on a populated database, plus the figures of the frozen schema-23 fixture and a current-schema world).
- **Objects that must be re-created identically (from `sqlite_master`, not memory), plus the new ones:** indexes `idx_sale_items_product`, `idx_sale_items_sale`; triggers `trg_sale_items_book_mismatch`, `trg_sale_items_extra_cost_immutable`, `trg_sale_items_immutable` (extended so that the new columns are immutable too), `trg_sale_items_no_delete`, `trg_sale_items_segment_matches`. Foreign-key child `sales_return_items` (REFERENCES `sale_items(id)`) must still validate. Triggers on other tables that read `sale_items` must still be present and behave identically: `trg_sales_return_items_exceeds`, `trg_sales_return_items_extra_exceeds`, `trg_sales_return_items_mismatch`, `trg_sales_returns_void_effects`, `trg_stock_movements_return_restock`, `trg_stock_movements_return_reversal_cap`. Closed-day (019/026), backdating (016), void (020), return (017) and correction (022) protections are unchanged and re-tested.
- **Restore validator:** a new invariant for the file being restored: per sale `total = sum of net revenue`; every discount column consistent with the formulas above; Telecom lines all zero; `price_reduction = qty x max(0, list - price)`; discounts <= gross; refused with `RESTORE_INVALID` when broken.
- **Tests required:** populated-database migration test (not only empty), raw-SQL bypass attempts (Telecom discount, wrong arithmetic, editing a discount column, deleting a line), the complete regression suite, the financial reconciliation (stock = movements, cash books = entries, Telecom total = sum of segments, Ice Cream funds), a launcher-based live run and a browser check of POS, History, Reports, dashboard.

## 9. Worked examples (Sri Lankan rupees)

Shop: charger list price Rs 1,500.00, automatic cost Rs 720.00, minimum selling price Rs 1,200.00. Cable list price Rs 350.00, automatic cost Rs 140.00. Telecom: Dialog card Rs 100.00.

**Example 1 - per-unit discount.** 4 chargers, discount Rs 75.00 per unit: G = 6,000.00, LD = 75.00 x 4 = 300.00, D = 300.00, **N = 5,700.00** (cash in, `sale_goods`). COGS 4 x 720.00 = 2,880.00. Profit **Rs 2,820.00** (Rs 3,120.00 without discount). Per-unit net price 1,425.00 (>= minimum 1,200.00, >= cost 720.00: no warning).

**Example 2 - whole-bill discount only.** 2 chargers (3,000.00) + 3 cables (1,050.00): S = 4,050.00; B = Rs 100.00 (10,000 cents). exact: charger 10,000 x 300,000 / 405,000 = 7,407.407..., cable 2,592.592...; floors 7,407 + 2,592 = 9,999; leftover 1 cent goes to the larger remainder (cable .592 > charger .407) -> **charger 7,407 c = Rs 74.07, cable 2,593 c = Rs 25.93** (sum 100.00). N: charger 2,925.93, cable 1,024.07, Shop total **Rs 3,950.00**. COGS 1,440.00 + 420.00 = 1,860.00; profit **Rs 2,090.00**.

**Example 3 - per-unit discounts plus a bill discount.** Same cart; Rs 100.00 per unit on the chargers (LD = 200.00, A_charger = 2,800.00), then B = Rs 150.00 on S = 2,800.00 + 1,050.00 = 3,850.00. exact: charger 15,000 x 280,000 / 385,000 = 10,909.09..., cable 4,090.909...; floors 10,909 + 4,090 = 14,999; the cent goes to the cable (.909 > .090) -> **charger Rs 109.09, cable Rs 40.91**. N: charger 2,690.91, cable 1,009.09, total **Rs 3,700.00** (= 4,050.00 - 200.00 - 150.00). D = 200.00 + 150.00 = 350.00; G - D = 4,050.00 - 350.00 = 3,700.00 = N.

**Example 4 - typed Shop price below list (price reduction).** The cashier types Rs 1,400.00 instead of Rs 1,500.00 for 2 chargers: PR = 2 x 100.00 = 200.00 (recorded automatically), P = 1,400.00, N = 2,800.00; G = 3,000.00; G - D = 3,000.00 - 200.00 = 2,800.00 = N. If the cashier also types Rs 50.00 per unit, LD = 100.00 and N = 2,700.00 (D = 300.00).
**Typed Shop price above list:** Rs 1,600.00: no price reduction, G = qty x 1,600.00 (an ordinary higher price), D = 0.

**Example 5 - extra cost C13 unchanged.** 4 chargers, cost entered Rs 730.00 (automatic 720.00, extra 10.00 per unit), Rs 75.00 per unit discount: net revenue 5,700.00; automatic COGS 2,880.00; extra cost 40.00; **profit 5,700.00 - 2,880.00 - 40.00 = Rs 2,780.00**. The discount changes neither stock nor cost.

**Example 6 - partial returns refund the discounted amount.** From example 5, return 1 of 4 (resalable): refund `mulDivRound(570,000, 1, 4)` = 142,500 c = **Rs 1,425.00** (not 1,500.00); automatic cost 720.00 and extra 10.00 reverse; stock returns at 720.00; profit after the return = 4,275.00 - 2,160.00 - 30.00 = **Rs 2,085.00**. Exact remainder: 3 units at Rs 1,700.00 = 5,100.00 with a Rs 100.00 bill discount (a single Shop line, so the whole discount goes to it): N = **Rs 5,000.00**; returning one unit at a time refunds Rs 1,666.67, Rs 1,666.67 and the last unit **Rs 1,666.66** (total 5,000.00 = paid).

**Example 7 - warnings (never block).** One charger, minimum price Rs 1,200.00, cost Rs 720.00. Discount Rs 400.00 per unit: net unit price Rs 1,100.00 < 1,200.00 -> `PRICE_BELOW_MINIMUM` (not below cost). Discount Rs 800.00 per unit: net Rs 700.00 < 720.00 -> `PRICE_BELOW_COST` and `PRICE_BELOW_MINIMUM`. The sale is saved in both cases. For whole-bill shares the same test uses the line's net (example 3: cable net 1,009.09 for 3 units = 336.36 each, judged as `1,009.09 < 3 x minimum`).

**Example 8 - mixed checkout with Telecom segments.** The cart of example 3 (Shop) plus 5 Dialog cards x Rs 100.00 and 2 Airtel cards x Rs 100.00. The bill discount of Rs 150.00 applies to the Shop subtotal 3,850.00 only. Saved as **three sales**: Shop Rs 3,700.00 (Shop cash book +3,700.00), Dialog Cards Rs 500.00 (Telecom - Dialog Cards +500.00), Airtel Cards Rs 200.00 (Telecom - Airtel Cards +200.00); all Telecom lines D = 0. The customer pays Rs 4,400.00. A cart with only cards shows no discount option.

**Example 9 - refusals.** Per-unit discount Rs 1,600.00 on a Rs 1,500.00 charger: refused (above the price). In example 3's cart a bill discount of Rs 3,900.00 is refused (Shop subtotal Rs 3,850.00; the Rs 700.00 of cards cannot absorb it); exactly Rs 3,850.00 is accepted (free Shop sale, no cash entry, the Telecom sales unchanged). Any discount on a Dialog card line is refused `DISCOUNT_NOT_ALLOWED`.

**Example 10 - report reconciliation for a day.** Sale A = example 1 (G 6,000.00; LD 300.00; N 5,700.00); sale B = example 3 (G 4,050.00; LD 200.00; bill 150.00; N 3,700.00); a voided sale of Rs 1,000.00 is excluded.
```
Gross Sales                          10,050.00
Discounts                               650.00
   Price Reductions                       0.00
   Per-unit Line Discounts              500.00
   Whole-bill Discounts                 150.00
Net Sales                             9,400.00      = 5,700.00 + 3,700.00 = the existing Shop sales revenue
```
10,050.00 - 650.00 = 9,400.00. The Telecom report for the same day shows no discount lines.

## 10. Consistency check (done 2026-11-17)

- **Formulas:** examples 1 to 10 were recomputed in cents; the identity `G - D = N` holds for every line (including typed prices above list); the largest-remainder shares add up exactly in examples 2 and 3; refunds in example 6 add up to the amount paid.
- **Existing accounting rules:** no approved formula changes (COGS, C13, C5, weighted average, R4/R-VR, R9, R-FD, backdating, R7, R13 all untouched; revenue stays the amount paid so every existing report formula keeps working); the cash entry equals the net total as it equals the total today.
- **Telecom segments (13D):** discounts exist only for `book = 'shop'` (segment NULL); Telecom sales per segment, their cash entries, per-segment closings, balances and P&L are unaffected; the segment triggers and `trg_sale_items_segment_matches` keep their meaning; the Telecom discount protection is in the database as well as in the service.
- **Corrections, returns, restore, reports:** covered in sections 6 to 8.

## 11. Remaining technical risks (for the implementation)

1. **Table rebuild of `sale_items`** touches the heaviest dependency web (returns, restocks, void effects, segment/book triggers, FK child `sales_return_items`). Mitigation: the object-set guard, the byte-for-byte populated-database test and the fixtures.
2. **Report reconciliation breadth:** every report, dashboard figure and Excel sheet that reads Shop revenue must keep equalling Net Sales; add the identity as automated assertions (Gross - Discounts = Net; Net = existing revenue) for P&L, cash-book totals, operational reports and the export pack.
3. **Fractional per-unit net prices:** a bill-discount share can make `N / qty` a non-whole number of cents; the line total is exact, the screens show the exact line total and an approximate unit price; warnings use the integer line comparison (section 5).
4. **Test churn:** existing tests that assert exact sale/line key lists or sheet lists gain the new fields (additive); the sales correction comparison and POS tests need the new fields.
5. **Assumption to confirm at implementation start:** discounts apply to **POS goods sales** only. Print/service sales (Services screen), although in the Shop book, are not POS goods lines and are not discounted by this design; if the owner wants discounts there it is a separate decision.
6. **No upper limit by design (decision 10):** a very large discount is possible; the only controls are the arithmetic rule, the audit log, the Discounts report and the below-minimum/below-cost warnings.
7. **Migration timing:** the rebuild runs inside the migration transaction at the next start-up after the update; the start-up backup taken before it is the way back.

## 12. Implementation outline (not started; waits for the owner's instruction)

Migration 027 and its tests; POS create/validation and allocation; returns and corrections reading the net amounts; Shop reports, dashboard and exports; restore-validator invariants; POS, History and Reports screens; documentation. Built with the same orchestrator and agent workflow, one pull request, full regression, live run and browser verification before merge.
