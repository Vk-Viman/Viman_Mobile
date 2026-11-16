# Proposal (version 3): sales discounts, Shop products only, typed in rupees

**Status: PROPOSED. Nothing is implemented. This version replaces versions 1 and 2 after the owner's clarifications of 2026-11-15 and 2026-11-16. The formulas below need your explicit approval before any code is written. Decisions 2, 3 and 4 were answered on 2026-11-16 (largest remainder; Shop typed price below list = discount; Telecom prices stay editable); decisions 5 to 7 remain.**

What changed in this version:
- **Only SHOP products can be discounted. TELECOM products never receive a discount** (all scratch cards and every Dialog, Mobitel, Hutch and Airtel product).
- The per-item discount is a fixed rupee amount **per unit**: line discount = discount per unit x quantity.
- The whole-bill discount applies **only to the Shop subtotal**.
- The earlier idea of splitting a bill discount between a Shop sale and a Telecom sale is **removed**.
- Still true from version 2: amounts are typed by the owner or cashier at the time of the sale; **no percentages, no predefined amounts, no limits, no confirmation threshold, no authorization step**. The only refusal is arithmetic: a discount cannot be larger than the amount it is taken from.

Amounts are Sri Lankan rupees; the program stores integer cents (Rs 74.07 = 7,407 cents). `mulDivRound` is the existing exact integer rounding helper.

---

## 1. Checklist of your requirements

| Requirement | How it is met |
|---|---|
| Only Shop products are eligible | Rule D-3: the server refuses any discount on a Telecom line (`DISCOUNT_NOT_ALLOWED`) and the database refuses a non-zero discount on a Telecom sale |
| Telecom products never discounted | Telecom lines and Telecom sales always have discount 0, in every report too |
| Per-item discount = fixed LKR per unit | Section 2.1: line discount = per-unit discount x quantity |
| Whole-bill discount only on the Shop subtotal | Section 2.2 |
| Mixed Shop + Telecom checkout: discounts from Shop lines only; Telecom unchanged; nothing allocated to Telecom; cash books separate | Section 3 |
| Cart with only Telecom products: no discount option | Section 3 (the discount fields are hidden) |
| Discount reports: Shop only, Telecom always zero | Section 6 |
| Show subtotal, discount, final payable | Section 5 |
| Discount recorded separately for reporting | Section 4 |
| Original selling prices preserved | Section 2.3 |
| Discounts reduce revenue, not COGS; C13 unchanged | Rules D-1, D-2; example 5 |
| Partial returns refund the actual discounted amount | Section 6, examples 6 |
| Existing void, return, stock, cash book and append-only rules preserved | Section 6 and 7 |

## 2. The two discount kinds (Shop lines only)

### 2.1 Per-item discount: a fixed rupee amount per unit
The cashier types an amount `d` in rupees **per unit** on a Shop cart line.
- `line discount L = d x qty` (exact, no rounding: both numbers are whole cents and whole units).
- Rule D-4: `0 <= d <= unit price`, otherwise refused (`DISCOUNT_EXCEEDS_AMOUNT`, "A discount cannot be larger than the price it is taken from"). `d` equal to the unit price makes the line free.
- Line amount after the line discount = `qty x (unit price - d)`.

### 2.2 Whole-bill discount: one rupee amount for the Shop part of the bill
The cashier types one amount `B`.
- **Eligible Shop subtotal `S`** = the sum of the **Shop** line amounts after their per-unit discounts. Telecom lines are not in `S`.
- Rule D-5: `0 <= B <= S`, otherwise refused.
- `B` is allocated across the **Shop lines only**, in proportion to each Shop line's amount after its line discount, so that the shares add up to exactly `B`, to the cent (largest-remainder method):
  1. `exact_i = B x a_i / S` (exact arithmetic, `a_i` = the line's amount in cents).
  2. `floor_i = floor(exact_i)`.
  3. `leftover = B - sum of floor_i` (between 0 and the number of Shop lines minus 1 cents).
  4. One extra cent goes to each of the `leftover` lines with the largest fractional remainder (`exact_i - floor_i`); ties go to the earlier line.
  A line can never receive more than its own amount (it only gets the extra cent when its exact share is not a whole number, so `floor + 1 <= exact <= a_i`). The alternative "the last line takes whatever is left" (the C5 return style) can in rare cases give the last line more than its own amount; both are exact to the cent. **Decision 2.**
- A line's total discount = its per-unit line discount + its share of `B` (+ any price reduction, section 2.3).

### 2.3 The list price is never lost (price edit = discount, Shop lines)
Every Shop line keeps the product's **list (normal) selling price** as it was when the sale was made.
- Rule D-7: if the cashier types a price **below** the list price, `(list - typed) x qty` is recorded as a **price reduction** (a discount) on the line, the line shows *normal price, discount, final price*, and the report counts it as a discount. The cashier may also type the per-unit discount instead; both end in the same discount figures.
- A typed price **above** the list price is an ordinary higher price (no discount, as today).
- **Telecom lines:** a typed price is never recorded as a discount and never creates one. **Decision 4** asks whether Telecom prices are locked to the list price (recommended, so "Telecom is never discounted" cannot be bypassed by editing the price) or stay editable as today without being recorded as a discount.

## 3. Mixed Shop + Telecom checkout (and Telecom-only carts)

Today a cart holding Shop goods and Telecom scratch cards is saved as **two sales, one per cash book**. That stays exactly as it is.
- Discounts are calculated from the **Shop lines only** (their per-unit discounts, then `B` on the Shop subtotal).
- **Telecom prices and totals are not touched.** No part of any discount is allocated or split to Telecom.
- The Shop sale's cash entry = its net total (Shop book). The Telecom sale's cash entry = its total exactly as today (Telecom book). The two cash books stay separate and accurate. (With the approved Telecom segments, the Telecom sale is further saved per provider segment; that does not interact with discounts.)
- The POS cart shows the discount fields on Shop lines only, and the bill-discount box is labelled "Shop discount" and shows the Shop subtotal it applies to.
- A cart that contains **only Telecom products** shows **no discount option at all** (per-unit and bill discount hidden); the server also refuses any discount on such a request.

## 4. Formulas (final wording for approval)

For every **Shop** sale line:
```
gross            = qty x list unit price
price reduction  = max(0, list unit price - charged unit price) x qty
line discount    = d x qty                        (d = typed rupees per unit, default 0)
bill share       = allocation of B (section 2.2)  (default 0)
discount         = price reduction + line discount + bill share
revenue (net)    = qty x charged unit price - line discount - bill share
```
For every **Telecom** line, discount = 0 and revenue = `qty x price` exactly as today.
Sale total (cash in) = sum of its lines' net revenue; the cash book entry equals that total, as it does today.

**Profit** = net revenue - COGS - extra cost (C13). COGS and the C13 extra cost are the existing figures and are never changed by a discount. All report formulas keep working because they already read "revenue"; revenue becomes the net figure. **Every historical sale has discount 0 and is not changed.**

**Rule D-3/D-4/D-5 (the only limits):** a discount on a Telecom line is refused (`DISCOUNT_NOT_ALLOWED`); a per-unit discount above the unit price, or a bill discount above the Shop subtotal after line discounts, is refused (`DISCOUNT_EXCEEDS_AMOUNT`). Whole amount = a free line or free Shop bill (existing free-sale behaviour: no cash entry when the Shop total is 0).

## 5. What the cashier sees (POS and History)

Per Shop line: **Normal price | Qty | Discount per unit (Rs, typed) | Line amount**.
Bill box (mixed cart example from section 8):
```
Shop subtotal (normal prices)     4,050.00
Shop line discounts                -200.00   (includes price reductions)
Shop bill discount (typed)         -150.00
Shop total                        3,700.00
Telecom total (no discount)         500.00
TOTAL TO PAY                      4,200.00
```
The same breakdown appears on the sale in History (the Shop sale and the Telecom sale of one checkout are shown as today). The existing warnings "price below minimum price" and "below cost" stay and are judged on the net unit price (`net / qty`); they warn, never block.

## 6. Returns, voids, reports

- **Partial returns (Shop):** C5 applied to the **net** line amount actually paid: `refund for q units = mulDivRound(line net revenue, q, line qty)`; the return that brings the returned quantity to the whole line takes the exact remainder; cost and C13 extra cost reverse in proportion as today. Telecom returns are unchanged.
- **Voids:** reverse the net cash entry and the stock exactly as today (same date, linked reversal entries). A voided sale contributes to no report. Void of a return (R-VR), closed days, backdating and future-date rules, stock movements and append-only ledgers are unchanged.
- **Reports and dashboard (presentation only):** Shop P&L gets informational lines **Gross sales / Discounts (price reductions, per-unit line discounts, bill discounts) / Net sales**; Net sales equals today's sales figure. A **Discounts report** covers **Shop only** (by date, product, category; voided sales excluded; Excel export); Telecom discounts are always zero and the Telecom report shows no discount lines. One dashboard figure "Shop discounts today / this month". No profit formula changes.

## 7. How it would be built (after approval)

- **Migration (next free number after the Telecom segments one):** rebuild `sale_items` adding `list_unit_price_cents`, `price_reduction_cents`, `line_discount_cents`, `bill_discount_share_cents` (existing rows copied with list = charged price and all discounts 0; no historical value changes, verified before/after on a populated database). The check `revenue = qty x unit price` becomes `revenue = qty x charged price - line discount - bill share`, with `discount <= gross`. **A database trigger refuses any non-zero discount column on a line whose sale is in the Telecom book.** The sales header records the typed bill discount. All existing triggers (closed day, void reversal, returns, future dates) are re-created unchanged; no protection is weakened.
- Services: POS create validates D-3/D-4/D-5 and allocates; returns keep reading `revenue_cents` (now net); reports add informational lines; the approved "correct this entry" for sales carries discounts too.
- Tests: hand-calculated scenarios for every example below, exact-allocation properties (sum equals the typed amount, no line exceeds its amount, deterministic ties), Telecom refusals in the API and in raw SQL, mixed-cart cash books, returns and void reconciliation (cash book = sum of entries, stock = sum of movements), migration on a populated database, randomized runs against an independent model; every existing test unchanged.

## 8. Worked examples (Sri Lankan rupees)

Shop: charger list Rs 1,500.00, automatic cost Rs 720.00; cable list Rs 350.00, automatic cost Rs 140.00. Telecom: Dialog card Rs 100.00.

**Example 1 - per-unit discount.** 4 chargers = Rs 6,000.00. The cashier types **Rs 75.00 per unit** -> line discount 75.00 x 4 = **Rs 300.00** -> net **Rs 5,700.00** (cash in). COGS 4 x 720.00 = 2,880.00. Profit **Rs 2,820.00** (Rs 3,120.00 without the discount).

**Example 2 - whole-bill discount only.** Shop cart: 2 chargers (Rs 3,000.00) + 3 cables (Rs 1,050.00) = Shop subtotal Rs 4,050.00. Bill discount typed: Rs 100.00. Charger exact 100 x 3,000 / 4,050 = 74.074..., cable 25.925...; floors 74.07 + 25.92 = 99.99; the leftover cent goes to the cable (.925 > .074) -> **charger Rs 74.07, cable Rs 25.93** (sum Rs 100.00). Net charger Rs 2,925.93, cable Rs 1,024.07, Shop total **Rs 3,950.00**. COGS 1,440.00 + 420.00 = 1,860.00; profit **Rs 2,090.00**.

**Example 3 - per-unit discounts and a bill discount together.** Same Shop cart; Rs 100.00 per unit on the chargers (2 x 100 = Rs 200.00 line discount, line Rs 2,800.00), then a bill discount of Rs 150.00 on the Shop subtotal after line discounts: S = 2,800.00 + 1,050.00 = 3,850.00. Charger exact 150 x 2,800 / 3,850 = 109.0909..., cable 40.9090...; floors 109.09 + 40.90 = 149.99; the leftover cent goes to the cable -> **charger Rs 109.09, cable Rs 40.91**. Net charger 2,690.91, cable 1,009.09, Shop total **Rs 3,700.00** (= 4,050 - 200 - 150).

**Example 4 - mixed checkout.** The cart of example 3 plus **5 Dialog cards x Rs 100.00 = Rs 500.00**. The bill discount of Rs 150.00 applies to the Shop subtotal of Rs 2,800.00 + 1,050.00 only; the Telecom cards receive nothing. Saved as two sales: **Shop sale Rs 3,700.00** (Shop cash book +3,700.00) and **Telecom sale Rs 500.00** (Telecom cash book +500.00, unchanged). The customer pays **Rs 4,200.00**. A cart of only the 5 cards shows no discount option and total Rs 500.00.

**Example 5 - extra cost C13 (unchanged by the discount).** 4 chargers, cost entered Rs 730.00 (automatic Rs 720.00, extra Rs 10.00 per unit), Rs 75.00 per unit discount:

| | Amount |
|---|---|
| Gross | Rs 6,000.00 |
| Discount (75.00 x 4) | - Rs 300.00 |
| Net revenue (cash in) | Rs 5,700.00 |
| Automatic COGS | Rs 2,880.00 |
| Extra cost (4 x Rs 10.00) | Rs 40.00 |
| **Profit** | 5,700.00 - 2,880.00 - 40.00 = **Rs 2,780.00** |

**Example 6 - partial returns refund the discounted amount.** From example 5, return 1 of the 4 units (resalable): refund `mulDivRound(570,000 cents, 1, 4)` = 142,500 cents = **Rs 1,425.00** (not Rs 1,500.00). Automatic cost 720.00 and extra cost 10.00 are reversed in proportion; stock back at Rs 720.00. Profit after the return: revenue 4,275.00 - COGS 2,160.00 - extra 30.00 = **Rs 2,085.00**.
**Exact remainder:** 3 units x Rs 1,700.00 = Rs 5,100.00 on a single-line Shop bill with a bill discount of Rs 100.00 (a whole-bill discount does not divide evenly by 3 units) -> net **Rs 5,000.00**. Returning one unit at a time refunds Rs 1,666.67, Rs 1,666.67 and the last unit **Rs 1,666.66**; total refunded Rs 5,000.00 = the amount paid.

**Example 7 - refusals.** Per-unit discount of Rs 1,600.00 on a Rs 1,500.00 charger: refused (above the unit price). In example 3's cart a bill discount of Rs 3,900.00 is refused because the Shop subtotal is Rs 3,850.00 (the Rs 500.00 of cards cannot be used to absorb it). Any discount typed on a Dialog card line, or sent to the server for one, is refused (`DISCOUNT_NOT_ALLOWED`). A bill discount of exactly Rs 3,850.00 is accepted (the Shop sale is free; the Telecom sale is still Rs 500.00).

## 9. Decisions I need from you

1. ~~Per-item amount~~ **Settled:** per unit (line discount = per-unit x quantity).
2. ~~Rounding~~ **Settled 2026-11-16: largest remainder.**
3. ~~Shop price field~~ **Settled 2026-11-16: yes.** A typed Shop price below the list price is recorded automatically as a discount; a price above list is a normal higher price.
4. ~~Telecom price field~~ **Settled 2026-11-16: Telecom prices stay editable as today.** A typed Telecom price is an ordinary price: it is never recorded as a discount, never appears in any discount report, and no discount field is offered on Telecom lines.
5. **Warnings** for "below minimum price" and "below cost" judged on the net unit price and never blocking. Confirm.
6. **Report wording and split** (Gross sales / Discounts: price reductions, line discounts, bill discounts / Net sales; Shop only). Confirm.
7. **Migration** (rebuild of `sale_items`, all protections re-created, populated-database test, plus the trigger that keeps Telecom discounts at zero). Confirm.

Without any limit the program cannot stop a cashier from giving a very large Shop discount; the only record is the Discounts report and the audit trail (every discount is stored with the sale).
