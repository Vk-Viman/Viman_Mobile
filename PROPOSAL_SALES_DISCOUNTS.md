# Proposal: sales discounts

**Status: DESIGN ONLY. Nothing is implemented and no formula is changed. Every formula below is a proposal that needs your approval.**
Amounts are Sri Lankan rupees; the program stores integer cents, so Rs 74.07 is 7,407 cents. "mulDivRound" is the program's existing rounding helper (round half up on exact integer arithmetic, used by returns C5 and commissions).

---

## 0. What exists today (so the proposal is measured against it)

- A POS line has **quantity** and **unit price**; the cashier can already **type a different price** per line. The line's revenue is exactly `qty × unit price` (the database enforces this equality, so it can never differ by a cent).
- COGS is the weighted-average cost snapshot of the stock removed; the cashier may **raise** (never lower) the cost per unit: the part above the automatic cost is the **extra cost (C13)**, a cost-side figure that changes no stock and no cash.
- Partial returns (C5): refund and cost reversal for `q` units = `mulDivRound(line amount, q, line quantity)`; the return that brings the returned quantity to the whole line takes the **exact remainder**.
- A price below cost or below the product's minimum price gives a **warning** but still saves.
- Because of the typed price, a cashier can "discount" today by lowering the price. What is missing: the **list price is lost**, so reports cannot say how much was discounted, and there is no limit or audit of discounts.

## 1. Core idea: a discount is a reduction of revenue, never of cost

- **Gross** line amount = `qty × list price` (what the line would have been).
- **Discount** = an amount in cents taken off that line.
- **Net** line amount (the revenue recorded) = gross − discount. **Net revenue is what the customer pays, what goes into the cash book, and what profit uses.**
- **COGS and extra cost (C13) are never touched by a discount.** Discounting is a pricing decision; the cost of the goods is the same.
- Profit = net revenue − COGS − extra cost. All existing report formulas keep working because they already read "revenue"; revenue simply becomes the net figure. Existing sales have discount 0, so **no historical number changes**.

## 2. Discount types

| Type | Entered as | Computed as |
|---|---|---|
| Per-item, fixed | Rs amount off the whole line (not per unit) | `discount = amount` |
| Per-item, percentage | percent (stored as basis points, e.g. 10.00% = 1000) | `discount = mulDivRound(gross, bps, 10000)` |
| Whole-bill, fixed | Rs amount off the bill | allocated over the lines (section 3) |
| Whole-bill, percentage | percent of the bill | `billDiscount = mulDivRound(subtotal, bps, 10000)`, then allocated |

Rules (proposed):
- D-1 A discount can never exceed the amount it applies to (net ≥ 0). A 100% discount makes a free line (existing "free sale" behaviour, no cash entry when the bill total is 0).
- D-2 **Order of application:** per-item discounts first; a whole-bill discount applies to the **subtotal after per-item discounts**. Example: line 1 has Rs 300 off, the bill has 10% off the remaining total.
- D-3 Percentages are entered with up to 2 decimals and stored as basis points (same convention as commission rates).
- D-4 Telecom scratch cards are sold through the same POS and follow the same rules (their book gets its own part of the bill discount, see section 3).

## 3. Whole-bill discounts: exact allocation to lines

Returns, COGS and reports work **per line**, so a whole-bill discount must become a per-line amount. Proposal: allocate in proportion to each line's net-after-line-discount amount, using the **same exact-remainder idea as C5**, so the lines add up to the bill discount to the cent:

```
for every line except the last:  share = mulDivRound(billDiscount, lineAmount, subtotal)
last line:                        share = billDiscount − (sum of the other shares)
```

(In a cart that mixes Shop and Telecom lines, which is saved as two sales, the bill discount is split between the two sales the same way, first by book subtotal, then by lines. Each saved sale then has its own exact total.)

**Example A — Rs 100 off a two-line bill (fixed whole-bill discount)**

| Line | Qty × list price | Gross | Allocation of Rs 100.00 | Net |
|---|---|---|---|---|
| Phone charger | 2 × Rs 1,500.00 | 3,000.00 | 10,000 × 300,000 / 405,000 = 7,407 c = **Rs 74.07** | 2,925.93 |
| Cable | 3 × Rs 350.00 | 1,050.00 | remainder = 10,000 − 7,407 = **Rs 25.93** | 1,024.07 |
| **Bill** | | **4,050.00** | **100.00** | **3,950.00** |

Cash received: Rs 3,950.00. COGS (charger 2 × Rs 720.00 = 1,440.00; cable 3 × Rs 140.00 = 420.00) = 1,860.00. Profit = 3,950.00 − 1,860.00 = **Rs 2,090.00** (it would have been Rs 2,190.00 without the discount).

## 4. Worked examples (Sri Lankan rupees)

Product: charger, list price Rs 1,500.00, automatic cost Rs 720.00.

**Example B — per-item fixed discount.** 4 chargers: gross Rs 6,000.00, discount Rs 300.00 → net **Rs 5,700.00**. COGS 4 × 720.00 = 2,880.00. Profit **Rs 2,820.00** (Rs 3,120.00 without discount). Cash book +5,700.00.

**Example C — per-item percentage.** Same 4 chargers, 10%: discount `mulDivRound(600000, 1000, 10000)` = 60,000 c = Rs 600.00 → net Rs 5,400.00, profit Rs 2,520.00.

**Example D — whole-bill percentage.** Bill of Rs 4,050.00 (Example A lines), 10% off the whole bill = Rs 405.00: charger share 405.00 × 3,000/4,050 = Rs 300.00, cable Rs 105.00 (both exact). Net Rs 3,645.00.

### 4.1 Interaction with the extra-cost rule C13

The extra cost is a **cost-side** figure and is **not reduced by a discount**. Example E: the cashier raises the cost to Rs 730.00 (automatic Rs 720.00, extra Rs 10.00 per unit) and gives Rs 300.00 off 4 chargers:

| | Amount |
|---|---|
| Gross | Rs 6,000.00 |
| Discount | − Rs 300.00 |
| Net revenue (cash in) | Rs 5,700.00 |
| Automatic COGS | Rs 2,880.00 |
| Extra cost (4 × Rs 10.00) | Rs 40.00 |
| **Profit** | 5,700.00 − 2,880.00 − 40.00 = **Rs 2,780.00** |

Stock still leaves at Rs 2,880.00; the extra and the discount change no stock. The extra-cost rule itself (never lower than automatic, shown as its own figure) is unchanged.

### 4.2 Partial returns of a discounted line

The existing C5 formula is applied to the **net** line amount (the amount actually paid). The customer is refunded what they paid for those units, not the list price.

**Example F** (from Example E): return 1 of 4 units, resalable.
- Refund = `mulDivRound(570,000 c, 1, 4)` = 142,500 c = **Rs 1,425.00** (not Rs 1,500.00).
- Automatic cost reversed 720.00 and extra cost reversed 10.00 (proportional, as today); stock back at Rs 720.00.
- Profit after the return: revenue 4,275.00 − COGS 2,160.00 − extra 30.00 = **Rs 2,085.00**.

**Example G — the last return takes the exact remainder.** 3 × Rs 1,700.00 = 5,100.00, discount Rs 100.00, net **Rs 5,000.00**. Returning one unit at a time: Rs 1,666.67, then Rs 1,666.67, then the final unit **Rs 1,666.66** (the exact remainder), total refunded Rs 5,000.00 = net paid. No cent is created or lost.

**Damaged returns:** unchanged in principle: revenue (net share) and COGS reversed, loss counted once at automatic cost.

**Voiding a return** (R-VR) is unchanged: it restores exactly the revenue/cost that the return removed, including the net share.

### 4.3 Voiding a sale

Voiding reverses the **net** cash entry (the existing reversal entry, same date) and the stock movements. Because the discount is stored on the lines of the voided sale, a voided sale shows its original gross, discount and net, and **contributes nothing** to any report (gross sales, discounts and net sales all exclude voided sales, as revenue does today).

## 5. Limits and owner authorization

The program has no login and no users, so a "manager approval" cannot be tied to a person. Options:

| Option | How it works | Pros / cons |
|---|---|---|
| **A (recommended)** | Settings → Sales: **Maximum discount without confirmation** (a percentage of the line or bill, for example 10%) and an optional **Absolute maximum** (for example 25%). Above the first limit the POS asks "Discount is above the usual limit. Confirm?" and requires a short **reason**; above the absolute maximum it is refused (`DISCOUNT_ABOVE_LIMIT`). Every discount above the first limit is written to the audit log with the reason. | Works with one user; cannot stop the owner's own staff from clicking Confirm, but leaves an audit trail and shows in a report |
| B | Same as A plus an **owner PIN** typed to exceed the limit | Slightly stronger, but one shared PIN is weak without user accounts and it would be the first secret the program stores |
| C | Wait for login/roles (not built) and then require the owner role | Most correct, but depends on a feature that does not exist |

The existing warnings for "price below cost" and "below minimum price" remain and are judged on the **net unit price** (`net ÷ qty`). A discount that sells below cost warns (does not block), exactly like today's typed price.

Open question: if the cashier already changes the price field, is that a discount? Proposal: keep price editing (it is how many shops work) but **record the list price** so the difference is shown as a discount automatically; there is then only one mechanism in the reports (see section 7).

## 6. Receipts and the sale screen

There is **no receipt printing** in the program today (a future feature). Discounts will show on what exists now: the POS cart (list price, discount, net per line; bill total with "You save Rs …"), the sale detail in **History**, and any future receipt will print:

```
Phone charger   2 x 1,500.00        3,000.00
Cable           3 x   350.00        1,050.00
Subtotal                            4,050.00
Discount                             -100.00
TOTAL                               3,950.00
```

(The per-line shares of a whole-bill discount are stored but shown only in History detail, to keep the printed bill simple.)

## 7. Reports and dashboard (presentation only)

- **No change to any approved profit formula.** Revenue lines are the net amounts, so every existing total stays correct.
- New information (read-only): in the Shop and Telecom profit-and-loss add an informational line under sales: **"of which discounts given: Rs …"** and show **Gross sales / Discounts / Net sales**. Net sales equals the figure shown today.
- New operational report **Discounts**: by date range, product and category: gross, discount, net, discount %, count of sales above the usual limit (with reasons), voided sales excluded. Excel export like other reports.
- Dashboard: one extra figure on the sales card, "Discounts today / this month".
- Cash books are unaffected except that the sale's cash entry equals the net total (as today it equals the total).

## 8. How it would be built (after approval)

- **Migration 022 (forward-only):** rebuild `sale_items` with `list_unit_price_cents` and `discount_cents` columns. Existing rows copied with list price = unit price and discount 0 (no historical value changes; row counts and totals verified before and after on a populated database, like previous migrations). The current check `revenue = qty × unit price` becomes `revenue = qty × list price − discount`. All existing protection triggers (closed day, void reversal, returns) are re-created unchanged. The sales header gets the bill-discount fields. A new setting stores the limits.
- Services: POS create validates and allocates discounts with the formulas above; returns use net revenue (the existing C5 code reads `revenue_cents`, which stays the net figure); reports add the informational lines.
- Tests: hand-calculated scenarios for every example in this document (A to G), exact-remainder properties, returns and void reconciliation (cash book = Σ entries, stock = Σ movements), migration on a populated database, randomized runs against an independent model with discounts, and every existing test unchanged.

## 9. Decisions I need from you

1. Approve the idea that **discount reduces revenue and never cost**, so profit = net revenue − COGS − extra cost.
2. Approve **per-item and whole-bill**, **fixed and percentage** (all four), with per-item applied first.
3. Approve the **proportional allocation with exact remainder** for whole-bill discounts (section 3).
4. Approve refunds on partial returns of a discounted line = **C5 applied to the net amount** (Example F, G).
5. Choose the authorization option: **A (recommended)**, B or C, and the two limits (suggested: 10% confirm, 25% absolute maximum).
6. Should price editing record the list price and count as a discount (recommended), or stay as it is?
7. Confirm the report wording and that Net sales stays equal to today's "sales" figure.
8. Confirm migration 022 (table rebuild with all protections re-created and a populated-database test).
