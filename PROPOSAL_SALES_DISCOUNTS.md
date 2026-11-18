# Sales discounts: FINAL APPROVED DESIGN (Shop POS goods and Shop services; Telecom excluded; typed in rupees)

**Status: DESIGN APPROVED by the owner (2026-11-17; scope extended to printing and services 2026-11-17), NOT IMPLEMENTED.** Approval of this document is not authorization to build: implementation waits for the owner's separate instruction. This file replaces all earlier versions. The accounting rules are recorded in `BUSINESS_RULES.md` section 13C.

Amounts are Sri Lankan rupees; the program stores integer cents (Rs 74.07 = 7,407 cents). `mulDivRound` is the existing exact integer rounding helper (BUSINESS_RULES section 0).

---

## 1. Every decision (all approved; four small confirmations are listed in section 12)

| # | Decision |
|---|---|
| 1 | Discounts are entered manually in LKR at the time of the sale. |
| 2 | Only fixed LKR amounts. No percentages. |
| 3 | A per-item discount is typed **per unit**. |
| 4 | Total line discount = discount per unit x quantity. |
| 5 | A whole-bill discount applies only to the eligible **Shop** sale (the Shop subtotal of a POS checkout; the whole service sale of a printing/service record). |
| 6 | Telecom products never receive a discount (all scratch cards and every Dialog, Mobitel, Airtel and Hutch product, in all eight Telecom segments). Reloads, EZCash and top-ups are never discounted either. |
| 7 | Telecom prices stay editable, but a Telecom price change is never recorded as a discount. |
| 8 | A Shop selling price typed below the normal list price is automatically recorded as a **price reduction** (goods and services alike). |
| 9 | Whole-bill discounts are allocated with the **largest-remainder** method. |
| 10 | No predefined discount limits, no confirmation thresholds, no authorization steps; the only refusal is arithmetic. |
| 11 | Discounts reduce revenue, never COGS. |
| 12 | C13 extra cost is unchanged; service cost snapshots are unchanged. |
| 13 | Partial returns refund the actual discounted amount paid. |
| 14 | Stock valuation, cash books, Telecom segments, voids, returns and correction rules stay intact. |
| 15 (warnings) | Below-minimum-price and below-cost warnings are judged on the final net effective unit price after all Shop discounts; they never block; Telecom keeps its existing rules. |
| 16 (reports) | Shop reports show Gross Sales, Discounts (Price Reductions, Per-unit Line Discounts, Whole-bill Discounts) and Net Sales; Net Sales equals the existing Shop sales revenue; Telecom reports have no discounts; included in the Shop P&L, operational reports, dashboard and Excel exports; voided sales excluded; profit calculations unchanged. |
| 17 (migration) | A forward-only migration for `sale_items` (and, with the scope extension, `print_sales`) under the mandatory requirements of section 8, numbered from 027 (the next free number after the Telecom segment migrations 024 to 026). |
| **18 (NEW: services)** | **Discounts apply to Shop POS product sales AND to printing, photocopying and every other service sold on the Services screen** (all service types). Services belong to the Shop book. Per-service (per-unit) discounts and whole-bill discounts follow the same approved fixed-LKR rules and the same largest-remainder allocation. Discounts reduce revenue, never COGS; service cost snapshots and profit calculations are preserved; service prices, service types and cost calculations are not changed. Voids and corrections preserve every discount value and the audit history. |

## 2. Where discounts exist (scope)

| Record | Discount? | How |
|---|---|---|
| Shop POS goods sale (table `sale_items`, book shop, segment NULL) | **Yes** | per-unit discount, whole-bill discount on the Shop subtotal, price reduction |
| Printing, photocopying and every other service sale (Services screen, table `print_sales`, one service type and a quantity per record, `sale_service` cash entry) | **Yes** | per-unit discount (per page / copy / service unit), whole-sale discount, price reduction |
| Telecom sales (cards, all eight segments), reloads, EZCash, top-ups | **Never** | discount columns always zero, refused by the service and by database triggers |
| Ice Cream, purchases, expenses, supplies, drawings, transfers and every other record | No | not sales to customers |

- **Services are Shop-only by construction:** `print_sales` has no book or segment and no Telecom service type exists, so Telecom exclusion for services is structural; `sale_items` keeps its explicit Telecom trigger.
- **Mixed Shop sales.** A customer who buys goods and services in one visit creates **two records** (one POS sale and one service sale), as today; the POS does not sell services (BUSINESS_RULES 6; POS service lines remain a deferred decision). Each record has its own per-unit and whole-bill discount; there is **no allocation of a discount across the two records** (see confirmation C in section 12). A POS checkout with Shop goods and Telecom cards stays one Shop sale plus one Telecom sale per provider segment (13D): discounts are computed from the Shop lines only and nothing is allocated or split to Telecom; the Telecom sales and their segment cash entries are exactly what they would be without the feature. A cart containing only Telecom products offers no discount.

## 3. The rules and formulas (final)

**One Shop line** means a POS goods line, or the single service line of a print/service sale. Symbols: `qty` units, list price `L` (a product's normal selling price, or the service type's standard price, when the sale is made), typed selling price `P` (default `L`), typed discount per unit `d` (default 0), whole-bill share `s` (default 0).

```
charged unit price   P                                       (typed in the price field; default = L)
gross                G  = qty x max(L, P)                    (a price above L is an ordinary higher price)
price reduction      PR = qty x max(0, L - P)                (recorded automatically, decision 8)
line discount        LD = d x qty                            (decisions 3 and 4)
line amount          A  = qty x P - LD                       (the line after its own discount; basis of the allocation)
bill share           s  = largest-remainder share of the typed whole-bill discount B (section 4)
net revenue          N  = A - s  =  qty x P - LD - s         (= revenue_cents: the amount paid; goes to the cash book)
discount (total)     D  = PR + LD + s
identity             G - D = N        (true for every line, also when P > L)
cost                 COGS = automatic weighted-average cost (goods)   |   qty x service standard cost snapshot (services)   -- never changed by a discount
profit               N - COGS - C13 extra cost (goods; services have no extra cost)
```
For every **Telecom** line: `L = P`, `PR = LD = s = 0`, `N = qty x P` exactly as today (a typed Telecom price is simply the price, decision 7).
For a **service sale** the record has exactly one line, so a whole-bill discount `B` is that line's share (`s = B`) and the largest-remainder step is trivial; for a **POS checkout** the Shop lines share `B` in proportion to their amounts (section 4).
Sale total (cash in) = the sum of the lines' net revenue; the cash entry (`sale_goods` for POS goods, `sale_service` for services) equals it, and there is no entry when it is 0 (existing free-sale behaviour).
**Historical records** have `L = P`, `d = 0`, `s = 0`, so `PR = LD = s = D = 0` and `G = N = revenue_cents`: nothing is recalculated and no reported number changes. Existing service cost snapshots (`unit_cost_cents`, `cogs_cents`) are untouched.

**Limits (arithmetic only, decision 10):** `0 <= d <= P` per unit; for a POS checkout `0 <= B <= S` where `S` = sum of the Shop lines' amounts `A` (the Shop subtotal after per-unit discounts, never the whole cart); for a service sale `0 <= B <= A`; otherwise `DISCOUNT_EXCEEDS_AMOUNT`. Equal to the whole amount is allowed (a free line / free sale).

## 4. Whole-bill discount: largest-remainder allocation (approved)

The typed amount `B` (cents) is split over the **eligible Shop lines** in proportion to each line's amount `A_i`; `S = sum A_i`:
1. `exact_i = B x A_i / S` (exact integer arithmetic).
2. `floor_i = floor(exact_i)`.
3. `leftover = B - sum floor_i` (between 0 and the number of lines minus 1 cents).
4. One extra cent goes to each of the `leftover` lines with the largest fractional remainder (`exact_i - floor_i`); ties go to the lower line number.
Properties (tested): the shares add up to exactly `B`; no line receives more than its own amount; deterministic. If `S = 0` then `B` must be 0. A service sale has one line, so the share is the whole `B`.

## 5. Warnings (decision 15, approved)

For each Shop line the existing advisory warnings are judged on the **final net effective unit price** `N / qty`, compared on the line in integers:
- `PRICE_BELOW_MINIMUM` (goods only; service types have no minimum price today) when `N < qty x minimum selling price`.
- `PRICE_BELOW_COST` when `N < qty x unit cost` (goods: the charged unit cost the existing warning uses; services: the standard cost snapshot of the service type).
Warnings **never block** (R13). Telecom lines keep today's Telecom behaviour (typed unit price against minimum and cost; nothing to subtract). The screen shows the final net unit price next to a warning.

## 6. Returns, voids, corrections

- **POS goods returns (C5 on the amount paid):** `refund for q units = mulDivRound(N, q, qty)`; the return that brings the returned quantity to the whole line takes the exact remainder; cost and C13 extra cost reverse in proportion as today; resalable stock returns at the original automatic cost; a damaged return reverses revenue and cost and records the loss once.
- **Service sales have no returns today** (an error is cancelled by a void and re-entered, or by "Correct this entry"); the design adds no service return. Should a service return ever be introduced it follows the same rule: refund `mulDivRound(N, q, qty)` of the amount actually paid (see confirmation D).
- **Voids** (goods and services) reverse the net cash entry (`sale_goods` / `sale_service`) and the stock movements (goods) exactly as today, on the original date with linked reversal rows; the discount columns stay on the voided record; a voided record contributes to **no** report. Void of a goods return (R-VR), closed days (R9, per scope), backdating order, R-FD, stock movements and the append-only ledgers are unchanged.
- **Corrections ("correct this entry", 13E; Phase 1 sales, Phase 2 print sales):** the original keeps all its discount values (it is only voided); the replacement body carries the discount fields (typed price, per-unit discount, whole-bill discount) validated by the same rules; the comparison tables additionally show discount and net revenue, original versus replacement; the audit entries of the void, the create and the correction stay. For a service correction the replacement's **list price defaults to the original's list-price snapshot** so that an unchanged typed price does not silently become a different price reduction after the service type's price changed (see confirmation B). Atomicity, guards and segment rules are unchanged.
- **Telecom segments:** Shop records have segment NULL; Telecom sales carry their segments with all discount columns zero; Shop and Telecom cash entries stay in their own cash books and segments; per-segment balances, closings and the Telecom total are unaffected.

## 7. Reports (decision 16, approved; services included)

Shop only. Presentation of existing figures plus new read-only lines; no profit formula changes:
```
Gross Sales                          sum of G over posted Shop sales (goods + services) dated in the period
Discounts                            sum of D
   Price Reductions                  sum of PR
   Per-unit Line Discounts           sum of LD
   Whole-bill Discounts              sum of s
Net Sales                            sum of N          = the existing Shop sales revenue (goods sales + service revenue)
```
- **Split by kind:** every line above is also shown for **Product sales** (POS goods) and **Service sales** (printing, photocopying, other services, by service type), so each existing revenue line (goods sales; print/photocopy/other services) reconciles on its own.
- **Reconciliation (mandatory test):** for every period `Gross - Discounts = Net Sales`; `Net Sales` equals the existing Shop revenue to the cent (goods revenue from `sale_items`, service revenue from `print_sales`, as the Shop P&L, cash book totals and the dashboard already show); service cost of goods and the printing variance report (standard cost charged versus supplies spend) are unchanged because cost snapshots are unchanged.
- **Where:** Shop P&L (informational lines under sales), the Sales and Services operational reports (columns and a Discounts report by date, product / service type and category), the Backdated report (amount = net, unchanged), the dashboard (Shop discounts today / this month), and the Excel exports (new rows in the Shop P&L and Sales sheets, a Discounts sheet in the export pack).
- **Excluded:** voided records; Telecom reports (no discount lines; the Telecom segment blocks show zero); Combined P&L totals are unchanged in meaning. Returns stay a separate line dated by the return (R7).

## 8. Database migration (decision 17; extended by decision 18)

Forward-only, never editing an earlier migration, numbered from **027**. Review result: the discount feature needs **two** tables rebuilt, because the revenue arithmetic is a CHECK on both:
- **`sale_items`** (POS goods lines): `CHECK (revenue_cents = qty * unit_price_cents)`.
- **`print_sales`** (printing, photocopying and other services; one row per sale): `CHECK (revenue_cents = qty * unit_price_cents AND cogs_cents = qty * unit_cost_cents)`.
Recommendation: two migrations in the same release, **027 for `sale_items`** and **028 for `print_sales`**, each with its own guards (the tables are independent, and a smaller migration is easier to verify); a single migration is also acceptable (confirmation A). Both use the proven rebuild pattern of 015, 023 and 025: `PRAGMA defer_foreign_keys = ON`, copy the rows to a TEMP table, keep the `sqlite_sequence` value, `DROP TABLE`, `CREATE TABLE`, re-insert with the **same ids**, restore the sequence, re-create every index and trigger from `sqlite_master` (never from memory), then guards that **abort the migration** if any row differs, a foreign-key violation remains, or the object set is not exactly the old set plus the new objects.

**New columns (both tables):** `list_unit_price_cents` (existing rows: = `unit_price_cents`), `unit_discount_cents` (typed per unit; existing 0), `line_discount_cents` (= unit x qty; existing 0), `price_reduction_cents` (existing 0), `bill_discount_cents` (the line's whole-bill share; existing 0).
**New checks:** `revenue_cents = qty x unit_price_cents - line_discount_cents - bill_discount_cents`; `0 <= unit_discount_cents <= unit_price_cents`; `line_discount_cents = unit_discount_cents x qty`; `price_reduction_cents = qty x max(0, list_unit_price_cents - unit_price_cents)`; `revenue_cents >= 0`; discounts >= 0. Existing checks stay: `sale_items` (`returned_qty BETWEEN 0 AND qty`, `line_type`, `UNIQUE (sale_id, line_no)`, cost fields), `print_sales` (`cogs_cents = qty * unit_cost_cents`, dates, status/void rules, `client_ref UNIQUE`, the service-type reference).

**Objects to re-create identically and verify:**
- `sale_items`: indexes `idx_sale_items_product`, `idx_sale_items_sale`; triggers `trg_sale_items_book_mismatch`, `trg_sale_items_extra_cost_immutable`, `trg_sale_items_immutable` (extended: the new columns immutable), `trg_sale_items_no_delete`, `trg_sale_items_segment_matches`; foreign-key child `sales_return_items`; triggers on other tables that read `sale_items` and must still behave identically: `trg_sales_return_items_exceeds`, `trg_sales_return_items_extra_exceeds`, `trg_sales_return_items_mismatch`, `trg_sales_returns_void_effects`, `trg_stock_movements_return_restock`, `trg_stock_movements_return_reversal_cap`.
- `print_sales`: indexes `idx_print_sales_business_date`, `idx_print_sales_posted_at`, `idx_print_sales_type_date`; triggers `trg_print_sales_business_date_immutable`, `trg_print_sales_day_closed`, `trg_print_sales_day_closed_void`, `trg_print_sales_future_date`, `trg_print_sales_immutable` (extended to the new columns), `trg_print_sales_no_delete`, `trg_print_sales_posted_at_immutable`, `trg_print_sales_type_active`, `trg_print_sales_void_requires_reversal`; the foreign key to `print_service_types`; the cash-entry triggers that key on `ref_table = 'print_sales'` (record-void and reversal mirror) and the `corrections` link (entity `print_sales`) keep working unchanged. `print_sales` has no foreign-key children. No change to `print_service_types` (prices, costs, codes), which are not discounted themselves.
**Telecom protection in the database:** on `sale_items`, a BEFORE INSERT trigger refuses any non-zero discount column (or `list_unit_price_cents <> unit_price_cents`) when the owning sale has `book = 'telecom'` (every segment); services have no Telecom form; raw-SQL attempts are tested.
**Historical data:** every existing line and service sale gets zero discount; revenue, COGS, unit cost snapshots, extra costs, returned quantities, `sales.total_cents`, cash entries (`sale_goods`, `sale_service`, `card_sale`), stock movements, returns and corrections are **identical before and after** (tested table by table on a populated database, the frozen schema-23 fixture, and a current-schema world; Telecom segment figures included).
**Restore validator:** new invariants for the file being restored: per sale `total = sum of net revenue`; per print sale the revenue/discount arithmetic above; `price_reduction = qty x max(0, list - price)`; discounts <= gross; goods Telecom lines and everything Telecom all zero; refused with `RESTORE_INVALID` when broken.
**Other code that must read the new columns or keep reading net revenue (checklist for the implementation):** POS create and validation, `sales-correction`, returns, `printing.service`/`printing.repo` (create, void, list), `correction-print`, `fin-queries` (service revenue), `printing-variance`, `backdated-report`, `sales-report`, the dashboard and export pack, the web POS, History, Services and Reports screens.
**Tests required:** populated-database migration test (not only empty) for both tables; raw-SQL bypass attempts (Telecom discount, wrong arithmetic, editing a discount column, deleting a row, voiding without reversal, closed-day inserts for both tables); the complete regression suite; the financial reconciliation (stock = movements, cash books = entries, Telecom total = sum of segments, Ice Cream funds); a launcher-based live run and a browser check of POS, History, Services, Reports and the dashboard. Feature test matrix: product sales, printing, photocopying, other services, mixed Shop visits (goods plus services), goods returns, voids, corrections, Telecom exclusion (API and SQL, every segment), warnings, report identities and Excel exports.

## 9. Worked examples (Sri Lankan rupees)

Shop goods: charger list Rs 1,500.00, automatic cost Rs 720.00, minimum selling price Rs 1,200.00; cable list Rs 350.00, cost Rs 140.00. Services: photocopy (A4) list Rs 10.00 per copy, standard cost Rs 3.00; printing (colour page) list Rs 25.00, standard cost Rs 8.00; "phone setup" list Rs 1,000.00, standard cost Rs 200.00. Telecom: Dialog card Rs 100.00.

**Example 1 - goods, per-unit discount.** 4 chargers, Rs 75.00 per unit: G = 6,000.00; LD = 300.00; **N = 5,700.00**; COGS 2,880.00; profit **Rs 2,820.00** (3,120.00 without discount); net unit price 1,425.00: no warning.

**Example 2 - goods, whole-bill discount only (largest remainder).** 2 chargers (3,000.00) + 3 cables (1,050.00): S = 4,050.00; B = Rs 100.00. exact: charger 7,407.407..., cable 2,592.592...; floors 7,407 + 2,592 = 9,999; the leftover cent goes to the larger remainder (cable) -> **charger Rs 74.07, cable Rs 25.93**. N: 2,925.93 + 1,024.07 = **Rs 3,950.00**; COGS 1,860.00; profit **Rs 2,090.00**.

**Example 3 - goods, per-unit discounts plus a bill discount.** Same cart; Rs 100.00 per unit on the chargers (LD 200.00, A = 2,800.00); B = Rs 150.00 on S = 3,850.00: exact 10,909.09 / 4,090.91 -> floors 10,909 + 4,090, the cent to the cable -> **charger Rs 109.09, cable Rs 40.91**. N: 2,690.91 + 1,009.09 = **Rs 3,700.00**; D = 350.00; G - D = 4,050.00 - 350.00 = 3,700.00.

**Example 4 - goods, typed price below list.** 2 chargers typed at Rs 1,400.00: PR = 200.00 (automatic), N = 2,800.00, G = 3,000.00. With Rs 50.00 per unit as well: LD = 100.00, N = 2,700.00, D = 300.00. A typed price of Rs 1,600.00 (above list) is an ordinary higher price: no reduction, G = qty x 1,600.00, D = 0.

**Example 5 - goods, C13 extra cost unchanged.** 4 chargers, cost entered Rs 730.00 (extra 10.00 per unit), Rs 75.00 per unit discount: N 5,700.00; automatic COGS 2,880.00; extra 40.00; **profit 2,780.00**.

**Example 6 - goods return refunds the discounted amount.** From example 5, return 1 of 4: refund `mulDivRound(570,000, 1, 4)` = 142,500 c = **Rs 1,425.00**; automatic cost 720.00 and extra 10.00 reverse; profit after = 4,275.00 - 2,160.00 - 30.00 = **2,085.00**. Exact remainder: 3 units at Rs 1,700.00 = 5,100.00 with a Rs 100.00 discount: N = 5,000.00; refunds one unit at a time: Rs 1,666.67, Rs 1,666.67 and the last **Rs 1,666.66** (= 5,000.00).

**Example 7 - photocopying, per-unit discount.** 100 copies at Rs 10.00 = G 1,000.00; Rs 2.00 per copy: LD = 200.00; **N = 800.00**; COGS = 100 x 3.00 = 300.00 (the standard-cost snapshot, unchanged); profit **Rs 500.00** (700.00 without discount). Net unit price 8.00 >= cost 3.00: no warning. Cash entry `sale_service` +800.00.

**Example 8 - printing, typed price below the service price.** 20 colour pages, price typed Rs 20.00 instead of Rs 25.00: PR = 20 x 5.00 = 100.00 (automatic), N = 400.00, G = 500.00; COGS 20 x 8.00 = 160.00; profit **240.00**. Adding Rs 4.00 per page: LD = 80.00, N = 320.00, D = 180.00; net unit price 16.00 >= cost 8.00.

**Example 9 - other service with a whole-sale discount.** Phone setup, 1 unit, Rs 1,000.00; the owner types a discount of Rs 150.00 for the whole sale: the single line takes the whole share (s = 150.00); **N = 850.00**; COGS 200.00; profit **650.00**. A discount of Rs 1,000.00 would make it free (no cash entry); Rs 1,100.00 is refused.

**Example 10 - service with per-unit and whole-sale discounts, and a warning.** 50 copies at Rs 10.00 (G 500.00), Rs 1.00 per copy (LD 50.00, A = 450.00), whole-sale discount Rs 45.00: **N = 405.00**, D = 95.00, COGS 150.00, profit 255.00; net unit price 8.10. If the typed price were only Rs 2.50 per copy (N = 125.00 for 50 copies, 2.50 each, below the Rs 3.00 standard cost) the sale still saves, with `PRICE_BELOW_COST`.

**Example 11 - mixed Shop visit (goods + services = two records).** One charger with Rs 75.00 per unit (N 1,425.00, `sale_goods`) and 20 copies with Rs 1.00 per copy (G 200.00, LD 20.00, N 180.00, `sale_service`). Two records, two cash entries, Shop cash book +1,605.00. No discount is allocated across the two records.

**Example 12 - mixed POS checkout with Telecom segments.** Example 3's Shop cart plus 5 Dialog cards (Rs 500.00) and 2 Airtel cards (Rs 200.00): B = 150.00 applies to the Shop subtotal 3,850.00 only. Three sales: Shop Rs 3,700.00, Dialog Cards Rs 500.00, Airtel Cards Rs 200.00 (each in its own cash book and segment); the customer pays Rs 4,400.00; all Telecom discounts 0. A cart of only cards shows no discount option; any discount sent for a card line is refused `DISCOUNT_NOT_ALLOWED`.

**Example 13 - voids.** Voiding example 7 reverses the net cash entry (-800.00, same date, linked reversal), keeps `unit_discount_cents`, `line_discount_cents` and the cost snapshot on the voided record, and removes it from every report. Voiding example 1 additionally returns the 4 chargers to stock at their original cost.

**Example 14 - corrections.** Example 7 corrected to 120 copies at Rs 1.50 discount: the original (100 copies, N 800.00) is voided and keeps its values; the replacement has list price Rs 10.00 (the original's snapshot), LD = 120 x 1.50 = 180.00, N = 1,020.00, COGS = 120 x 3.00 = 360.00; the comparison shows revenue 800.00 -> 1,020.00, discount 200.00 -> 180.00, cost 300.00 -> 360.00.

**Example 15 - refusals.** Per-unit discount of Rs 1,600.00 on a Rs 1,500.00 charger, or Rs 12.00 per copy on a Rs 10.00 service: refused (above the price). In example 3's cart a bill discount of Rs 3,900.00 is refused (Shop subtotal Rs 3,850.00; the Rs 700.00 of cards cannot absorb it); exactly Rs 3,850.00 is accepted (free Shop sale, no cash entry, Telecom sales unchanged).

**Example 16 - report reconciliation for a day (products and services).** Sale A = example 1 (G 6,000.00; LD 300.00; N 5,700.00); sale B = example 3 (G 4,050.00; LD 200.00; bill 150.00; N 3,700.00); service sale C = example 7 (G 1,000.00; LD 200.00; N 800.00); service sale D = example 8 (G 500.00; PR 100.00; N 400.00); a voided sale of Rs 1,000.00 is excluded.
```
                                     Products     Services     Shop total
Gross Sales                          10,050.00     1,500.00     11,550.00
Discounts                               650.00       300.00        950.00
   Price Reductions                       0.00       100.00        100.00
   Per-unit Line Discounts              500.00       200.00        700.00
   Whole-bill Discounts                 150.00         0.00        150.00
Net Sales                             9,400.00     1,200.00     10,600.00   = existing Shop revenue (goods sales 9,400.00 + service revenue 1,200.00)
```
Checks: 11,550.00 - 950.00 = 10,600.00; products 10,050.00 - 650.00 = 9,400.00 = 5,700.00 + 3,700.00; services 1,500.00 - 300.00 = 1,200.00 = 800.00 + 400.00. The Telecom report for the same day shows no discount lines. The printing variance report keeps comparing the same standard cost charged (300.00 + 160.00 = 460.00) with supplies spend.

## 10. Consistency check (done 2026-11-17, services review included)

- **Formulas:** examples 1 to 16 were recomputed in cents; the identity `G - D = N` holds for every line including prices above list; the largest-remainder shares add up exactly; service COGS equals `qty x unit cost snapshot` unchanged; refunds add up to the amount paid.
- **Existing accounting rules:** no approved formula changes (COGS, C13, C5, weighted average, R12 service cost snapshot, R4/R-VR, R9, R-FD, backdating, R7, R13 untouched; revenue stays the amount paid so every existing report formula keeps working; the `sale_service` cash entry equals the net total as it equals the total today).
- **Telecom segments (13D):** discounts exist only for the Shop book; Telecom sales per segment, their cash entries, per-segment closings, balances and P&L are unaffected; services cannot be Telecom.
- **Corrections, returns, voids, restore, reports:** covered in sections 6 to 8. Service-specific findings: `print_sales` has one row per sale and no returns; the only other readers of its revenue are the Shop P&L service line, the printing variance report (cost side only), the Backdated report and the correction comparison.
- **Service pricing and types:** `print_service_types` (price, standard cost, code, active) are unchanged; a service type's price is only the list price `L` of a new sale.

## 11. Remaining technical risks (for the implementation)

1. **Two table rebuilds** (`sale_items` with the heaviest dependency web; `print_sales` with nine triggers). Mitigation: object-set guards and byte-for-byte populated-database tests per table.
2. **Report reconciliation breadth:** Shop revenue now has two sources (goods and services); the identities `Gross - Discounts = Net` and `Net = existing revenue` must hold for goods, services and the total in the P&L, cash-book totals, operational reports, dashboard and every Excel sheet.
3. **Fractional unit prices:** a share of a whole-bill discount can make `N / qty` a non-whole number of cents; line totals stay exact, warnings compare whole lines.
4. **Corrections of services:** the list-price default (original snapshot) must be implemented and tested so a changed service price cannot silently create a price reduction (confirmation B).
5. **Test churn:** tests that assert exact key lists, sheet lists or comparison fields (sales, print sales, corrections, reports) gain additive fields.
6. **No upper limit by design (decision 10):** a very large discount is possible; the controls are the arithmetic rule, the audit log, the Discounts report and the warnings.
7. **Migration timing:** the rebuilds run inside the migration transaction at the first start-up after the update; the start-up backup taken before it is the way back.

## 12. Small confirmations that remain (recommended answers given; none blocks the documents)

- **A. Migration numbering:** two migrations, 027 (`sale_items`) and 028 (`print_sales`) (recommended), or one migration 027 for both.
- **B. Corrections of services and goods:** the replacement's list price defaults to the original's list-price snapshot (recommended), unless the owner explicitly asks to re-read today's price.
- **C. Goods plus services in one visit:** stay two records with separate discounts (recommended; POS service lines remain deferred), versus one combined bill with a single whole-bill discount (would need POS service lines, a separate decision).
- **D. Service returns:** none are introduced (a service sale is cancelled by void or corrected); a future return would refund the net amount paid.

## 13. Implementation outline (not started; waits for the owner's separate instruction)

Migrations 027 (and 028) with tests; POS create/validation and allocation; Services create/void/correction; returns and corrections reading the net amounts; Shop reports, dashboard and exports (goods and services); restore-validator invariants; POS, History, Services and Reports screens; documentation. Built with the same orchestrator and agent workflow, one pull request, full regression, live run and browser verification before merge.
