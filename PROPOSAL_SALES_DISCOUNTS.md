# Proposal (version 2): sales discounts as manually typed rupee amounts

**Status: DESIGN ONLY. Nothing is implemented. This version replaces the first proposal after the owner's clarification of 2026-11-15. The formulas below need your explicit approval before any code is written.**

What changed from version 1: **no percentages, no predefined amounts, no limits (no 10% / 25%), no confirmation threshold, no authorization step.** The owner or cashier types a rupee (LKR) amount at the time of each sale. The only protection is arithmetic: a discount can never be larger than the amount it is taken from.

Amounts are Sri Lankan rupees; the program stores integer cents (Rs 74.07 = 7,407 cents). `mulDivRound` is the existing exact integer rounding helper.

---

## 1. What the owner asked for (checklist)

| Requirement | How it is met |
|---|---|
| Per-item discount: type an LKR amount for one product line | Section 2.1 |
| Whole-bill discount: type one LKR amount for the entire bill | Section 2.2 |
| No percentages, no predefined limits | None exist anywhere in the design |
| A discount cannot exceed the eligible selling amount | Rule D-3 (hard refusal `DISCOUNT_EXCEEDS_AMOUNT`) |
| Show subtotal, discount amount, final payable amount | Section 5 |
| Record the discount separately for reporting | Section 4 (stored on the line, reported separately) |
| Preserve original selling prices | Section 3 (list price kept on every line) |
| Discounts reduce revenue, not COGS | Rule D-1 |
| C13 extra cost unchanged | Rule D-2, example 5 |
| Whole-bill discount allocated proportionally, exact-remainder rounding | Section 2.2 |
| Partial returns refund the actual discounted amount paid | Section 6 |
| Existing void, return and append-only rules preserved | Section 6 and 7 |

## 2. The two discount kinds

### 2.1 Per-item discount (a rupee amount for one line)
The cashier types an amount `L` in rupees on a cart line. **`L` is the total taken off that line (not per unit).** (Decision 1 below.)
- Line gross = `qty × unit price`.
- Rule D-3: `0 ≤ L ≤ line gross`.
- Line amount after the line discount = `line gross − L`.

### 2.2 Whole-bill discount (one rupee amount for the bill)
The cashier types one amount `B` for the whole bill.
- Subtotal for the bill, `S` = sum of the **line amounts after line discounts**.
- Rule D-3: `0 ≤ B ≤ S`.
- `B` is allocated to the lines **in proportion to each line's amount after its line discount**, so that the shares add up to exactly `B`, to the cent (largest-remainder method, below). Each line's total discount = its line discount + its share of `B`.

**Exact-remainder allocation (largest remainder).** For line `i` with amount `a_i` (cents):
1. `exact_i = B × a_i / S` (exact arithmetic).
2. `floor_i = floor(exact_i)`.
3. `leftover = B − Σ floor_i` (always between 0 and the number of lines − 1 cents).
4. Give one extra cent to each of the `leftover` lines with the **largest fractional remainder** (`exact_i − floor_i`); ties go to the earlier line.

Why this and not "the last line takes whatever is left" (the C5 return style): with the last-line method the last line's share could in rare cases exceed that line's own amount (for example a bill discount equal to almost the whole bill with many lines). The largest-remainder method can never give a line more than its own amount (a line only receives the extra cent when its exact share is not a whole number, so `floor + 1 ≤ exact ≤ a_i`), always adds up exactly, and is deterministic. **Decision 2 below** asks you to choose; both are exact to the cent.

A cart holding both Shop goods and Telecom scratch cards is already saved as two sales (one per cash book). The typed bill discount is split between the two sales **in proportion to their subtotals with the same method**, then allocated to lines inside each sale. (Decision 4.)

## 3. The list price is never lost (price edit = discount)

Every sale line keeps the product's **list (normal) selling price** as it was when the sale was made.
- Rule D-4: if the cashier **types a price below the list price**, the program does not lose that: `(list price − typed price) × qty` is recorded as a **price reduction** (a discount) on the line, the line shows *normal price, discount, final price*, and the report counts it as a discount. The cashier may also type an amount in the discount box instead; both end up in the same discount figures.
- A typed price **above** the list price is an ordinary higher price (no discount, as today); the list price is still kept for information.
- The line therefore stores: list unit price, charged unit price, price reduction, line discount, bill-discount share.

(Decision 3 asks you to confirm this treatment of the price field.)

## 4. Formulas (final wording for approval)

For every sale line:
```
gross            = qty × list unit price                 (what the line would be at the normal price)
price reduction  = max(0, list unit price − charged unit price) × qty      (typed-price reductions)
line discount    = L                                      (typed rupee amount, per line, default 0)
bill share       = allocation of B (section 2.2)          (default 0)
discount         = price reduction + line discount + bill share
revenue (net)    = qty × charged unit price − line discount − bill share
                 = gross − discount            (+ surcharge when the charged price is above list)
```
Sale total (cash in) = sum of the lines' net revenue. The cash book entry equals the net total, exactly as the total is today.

**Profit** = net revenue − COGS − extra cost (C13). COGS and extra cost are the existing figures, never changed by a discount:
```
COGS            = automatic weighted-average cost removed from stock (unchanged, section 3 of BUSINESS_RULES)
extra cost C13  = (entered unit cost − automatic unit cost) × qty (unchanged)
```
All existing report formulas keep working because they already read "revenue"; revenue becomes the net figure. **Every historical sale has discount 0 and is not changed.**

**Rule D-3 (the only limit):** every discount is refused (`DISCOUNT_EXCEEDS_AMOUNT`, message "A discount cannot be larger than the amount it is taken from") if `L > line amount before the line discount` or `B > S`. A discount equal to the whole amount is allowed (a free line / free bill, which uses the existing free-sale behaviour: no cash entry when the bill total is 0).

## 5. What the cashier sees (POS and History)

Per line: **Normal price | Qty | Discount (Rs, typed) | Final price (per unit shown for information; line total exact)**.
Bill box:
```
Subtotal (normal prices)        4,050.00
Line discounts                    -200.00      (includes price reductions)
Bill discount (typed)             -150.00
TOTAL TO PAY                    3,700.00
```
The same breakdown is shown on the sale in History. (There is no receipt printing in the program; a future receipt would use the same lines.) The existing warnings "price below minimum price" and "below cost" stay and are judged on the **net unit price** (`net ÷ qty`); they warn but never block, exactly as today.

## 6. Returns, voids, reports

**Partial returns.** The existing C5 formula is applied to the **net** line amount, i.e. what the customer actually paid for the line:
`refund for q units = mulDivRound(line net revenue, q, line qty)`, and the return that brings the returned quantity to the whole line takes the exact remainder. Cost and extra cost are reversed in proportion exactly as today. (Example 6.)

**Voids.** Void of a sale reverses the net cash entry and the stock exactly as today (same date, linked reversal entries). The discount stays stored on the voided sale; a voided sale contributes to no report. Void of a return (R-VR) restores what the return removed, including the net share. The existing rules (newest return first, no void of a sale that has returns, closed days) are unchanged. All ledgers stay append-only.

**Reports and dashboard (presentation only).** Net sales stays equal to today's "sales" figure. New read-only lines: **Gross sales (normal prices) / Discounts / Net sales**, with the discounts split into *price reductions*, *line discounts* and *bill discounts*; an operational report **Discounts** (by date, product, category: gross, discount, net, count; voided sales excluded; Excel export); one dashboard figure "Discounts today / this month". No profit formula changes.

## 7. How it would be built (after approval)

- **Migration 023 (forward-only):** rebuild `sale_items` adding `list_unit_price_cents`, `price_reduction_cents`, `line_discount_cents`, `bill_discount_share_cents` (existing rows copied with list = charged price and all discounts 0; no historical value changes, verified before/after on a populated database like earlier migrations). The check `revenue = qty × unit price` becomes `revenue = qty × charged price − line discount − bill share`, with `discount ≤ gross` checks. The sales header records the typed bill discount. All existing triggers (closed day, void reversal, returns, future dates) are re-created unchanged; no protection is weakened.
- Services: POS create validates D-3 and allocates; returns keep reading `revenue_cents` (now net); reports add the informational lines; the "correct this entry" feature for sales (approved Phase 1) will carry discounts too.
- Tests: hand-calculated scenarios for every example below, exact-allocation properties (sum equals the typed amount, no line exceeds its amount, deterministic ties), returns and void reconciliation (cash book = Σ entries, stock = Σ movements), migration on a populated database, randomized runs against an independent model, and every existing test unchanged.

## 8. Worked examples (Sri Lankan rupees)

Charger: list price Rs 1,500.00, automatic cost Rs 720.00. Cable: list price Rs 350.00, automatic cost Rs 140.00.

**Example 1 — per-item discount.** 4 chargers = Rs 6,000.00; the cashier types a discount of Rs 300.00 → net **Rs 5,700.00** (cash in). COGS 4 × 720.00 = 2,880.00. Profit **Rs 2,820.00** (Rs 3,120.00 without the discount).

**Example 2 — whole-bill discount only.** 2 chargers (Rs 3,000.00) + 3 cables (Rs 1,050.00) = subtotal Rs 4,050.00; the owner types a bill discount of Rs 100.00. Allocation: charger exact 100 × 3,000 / 4,050 = 74.074…, cable 25.925…; floors 74.07 + 25.92 = 99.99; leftover 0.01 goes to the larger remainder (cable .925 vs .074) → **charger Rs 74.07, cable Rs 25.93** (sum Rs 100.00). Net charger Rs 2,925.93, cable Rs 1,024.07, total **Rs 3,950.00**. COGS 1,440.00 + 420.00 = 1,860.00; profit **Rs 2,090.00**.

**Example 3 — line discount and bill discount together.** Same cart; Rs 200.00 line discount on the chargers (Rs 3,000 → Rs 2,800.00), then a bill discount of Rs 150.00 on the subtotal after line discounts: S = 2,800.00 + 1,050.00 = 3,850.00. Charger exact 150 × 2,800 / 3,850 = 109.0909…, cable 40.9090…; floors 109.09 + 40.90 = 149.99; the leftover cent goes to the cable (.909 > .090) → **charger Rs 109.09, cable Rs 40.91**. Net charger 2,690.91, cable 1,009.09, total **Rs 3,700.00** (= 4,050 − 200 − 150).

**Example 4 — typed price below the list price.** The cashier changes the charger price from Rs 1,500.00 to Rs 1,400.00 for 2 units. The program records a **price reduction of Rs 200.00** (shown as a discount), normal price Rs 1,500.00, final line Rs 2,800.00. Nothing is lost: the report counts Rs 200.00 as a discount.

**Example 5 — extra cost C13 (unchanged by the discount).** 4 chargers, cost entered Rs 730.00 (automatic Rs 720.00, extra Rs 10.00 per unit), line discount Rs 300.00:

| | Amount |
|---|---|
| Gross | Rs 6,000.00 |
| Discount | − Rs 300.00 |
| Net revenue (cash in) | Rs 5,700.00 |
| Automatic COGS | Rs 2,880.00 |
| Extra cost (4 × Rs 10.00) | Rs 40.00 |
| **Profit** | 5,700.00 − 2,880.00 − 40.00 = **Rs 2,780.00** |

**Example 6 — partial returns refund the discounted amount.** From example 5, return 1 of the 4 units (resalable): refund `mulDivRound(570,000 cents, 1, 4)` = 142,500 cents = **Rs 1,425.00** (not Rs 1,500.00). Automatic cost 720.00 and extra cost 10.00 are reversed in proportion; stock back at Rs 720.00. Profit after the return: revenue 4,275.00 − COGS 2,160.00 − extra 30.00 = **Rs 2,085.00**.
**Exact remainder:** 3 units × Rs 1,700.00 = 5,100.00 with a Rs 100.00 discount → net **Rs 5,000.00**. Returning one unit at a time refunds Rs 1,666.67, Rs 1,666.67 and the last unit **Rs 1,666.66**; total refunded Rs 5,000.00 = the amount paid.

**Example 7 — refusals.** Example 3's cart: a line discount of Rs 3,100.00 on the chargers (line gross Rs 3,000.00) is refused; after a valid line discount of Rs 200.00 a bill discount of Rs 3,900.00 is refused because the subtotal is Rs 3,850.00. A bill discount of exactly Rs 3,850.00 is accepted (the bill is free).

## 9. Decisions I need from you (please answer each)

1. **Per-item amount means the total for the line** (not per unit). Confirm, or say per unit.
2. **Rounding of the bill discount:** (a) largest remainder (recommended: never exceeds a line, always exact) or (b) every line rounded and the last line takes the remainder (the C5 style).
3. **Price field:** a typed price below the list price is recorded automatically as a discount (recommended, as you approved); a typed price above the list price is a normal higher price. Confirm.
4. **Mixed Shop + Telecom cart:** split the typed bill discount between the two sales in proportion to their subtotals (recommended), or require the discount to be typed separately per book.
5. **Warnings** for "below minimum price" and "below cost" judged on the net unit price and never blocking. Confirm.
6. **Report wording and split** (Gross sales / Discounts: price reductions, line discounts, bill discounts / Net sales). Confirm.
7. **Migration 023** (rebuild of `sale_items`, all protections re-created, populated-database test). Confirm.

The earlier approval of "above 10% needs confirmation, 25% maximum" is **superseded** by your clarification and is not part of this design. Note that without any limit the program cannot prevent a cashier from giving a very large discount; the only record is the discount report and the audit log (every discount is stored with the sale and shown in the Discounts report).
