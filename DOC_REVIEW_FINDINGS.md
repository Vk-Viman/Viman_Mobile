# Documentation review findings (Phase 14)

Scope: `BUSINESS_RULES.md` (read-only for this review, line numbers below refer to the file at commit `a59ad03`) compared with the code at schema version 14, the migrations, the routes and services, the web app, and the other documents. Nothing in the code or in `BUSINESS_RULES.md` was changed. Method: read the rules, then read the migrations, route schemas, services and pages and compared. The full server suite was run on the merged tree during this review: 81 files, 1,681 tests, all passing. Tests were not read line by line, so "tested" below means "the existing suite passes", not "I confirmed a specific test covers it".

Summary: no approved business formula is contradicted by the code. The findings are mostly (1) places where the rules text is stale or inconsistent with itself, (2) a few behaviours that go beyond or fall short of the text, (3) decisions the code made that no rule records, and (4) one feature (Settings → Printing defaults) that is documented as operational but is not.

---

## 1. Contradictions: BUSINESS_RULES.md vs code or other documents

| # | Rule text | What the code does | Severity |
|---|---|---|---|
| C-1 | §3, line 43: "stocktake gain (current average × qty via `mulDivRound(value, gainQty, qty)`; if qty = 0, an entered unit cost)". C10, line 212: "if qty = 0 **or** value = 0, the gain uses an entered unit cost (required); otherwise current average." | `inventory.service.ts` `gainValue` (lines 230–239) follows C10: average only when `pool.qty > 0 && pool.valueCents > 0`, otherwise `UNIT_COST_REQUIRED`. | Low. The rules disagree with each other; code follows C10. §3 should say the same as C10. |
| C-2 | §3, line 47: "**Blocked:** any outflow > qty on hand ("Only 3 in stock — record a purchase or stocktake")". | `inventory.service.ts` line 65: message is `Not enough stock: 3 on hand, 5 needed.` The error carries `onHand` and `productId`; no web code builds "Only 3 in stock". | Low (wording only). Either change the code message or the rule quote. |
| C-3 | §4, line 53: "Lines processed in id order; qty checked per product across the whole cart (R13)." | A cart line has no id; lines are processed in **cart order** (`sales.service.ts`), which is also the stored `line_no`. Quantity is checked cumulatively per product across the cart. | Low (wording). |
| C-4 | §12, line 199: "every audit entry for a financial record carries `business_date` and `backdated` as columns (planned migration, see DATABASE_SCHEMA)". | Done in migration 004 (`audit_logs.business_date`, `audit_logs.backdated`). | Low. Stale "planned". |
| C-5 | §5, line 59: "Reload (daily total per provider …)". | Several reload rows per provider per day are allowed (no unique constraint; reports sum them). | Low. Wording: "one or more entries per provider per day". |
| C-6 | §2, line 30: `expense`, `expense_refund` listed as types. | `expense_refund` is never written: voiding an expense reverses the `expense` entry (same type, negated). The database allows the value. Same for stock movement type `sale_void` (§3 does not list it, but the code allows it): never written. | Low. Remove `expense_refund` from §2 or state it is unused/reserved. |
| C-7 | §4 R13, line 56: "Warnings, not blocks (R13): … negative cash-book balance." | Warnings are returned by creates, returns, top-ups, supplies, expenses, drawings, transfers, cash counts, Ice Cream writes and by voids of cash-in records. They are **not** returned by the voids of a sale, a print sale, a reload sale or an EZCash sale, which remove cash from the book (`voidSale`, `voidPrintSale`, `voidReloadSale`, `voidEzCashSale` return the item only). | Medium (partly implemented; see §3). |
| C-8 | §5/§6 and Phase 1 settings: the rules speak only of "configurable price and standard cost per page" (§6, line 66). The Settings screen has a **Printing defaults** tab. | `settings.printDefaults` is stored and shown but **no service reads it**. Print prices and costs come from `print_service_types` (seeded by migration 010, edited under Printing → Service types). Earlier documents said the settings list "seeds the print service types" and "is documented in the UI"; neither is true (`PrintingTab.tsx` says "later used to set up print services"). | Medium. Dead/misleading setting; needs an owner decision (§6, D-1). |

### Contradictions in the other documents (all corrected by the rewrite in this review)

| Old statement | Reality |
|---|---|
| `DATABASE_SCHEMA.md`: `sale_items.line_type` "(print/service added in Phase 7)". | `line_type` is `goods` or `card` only. Print sales have their own table (`print_sales`); services are not sale lines. |
| `DATABASE_SCHEMA.md` / `API_CONTRACTS.md`: print service types are "seeded from `settings.printDefaults`", settings JSON is "only the initial seed". | The migration seeds seven fixed rows. Nothing reads the settings list (C-8). |
| `API_CONTRACTS.md` planned list: `GET /go-live` "(checklist status)". | Does not exist. |
| `API_CONTRACTS.md` Phase 4/9: `POST /drawings` with `kind: "cash"` → `400 NOT_AVAILABLE_YET`; Phase 5: "`DAY_CLOSED` … arrive with the cash books". | All built; no `NOT_AVAILABLE_YET` code exists. `PRODUCT_NOT_SELLABLE_YET` remains in the code for service products, but its text ("cannot be sold yet") implies a future feature that no phase plans. |
| `DATABASE_SCHEMA.md`: `purchase_returns` / `sales_returns` have `BEFORE UPDATE OF business_date, purchase_id` triggers; `cash_entries` column `at`; `icecream_*` `at`; `import_runs(rows_read, rows_accepted, status previewed|imported|failed, …)`. | Return tables are append-only (no UPDATE trigger needed); the column is `posted_at`; `import_runs` has `mode`, `rows_total`, `rows_ok`, `rows_failed`, `status previewed|committed|rejected`. |
| `DATABASE_SCHEMA.md`: "service error handler maps a SQLite ABORT with `FUTURE_DATE_NOT_ALLOWED` to 400". | True, but per service (each service has its own abort mapper); an abort that no service maps becomes `500 INTERNAL_ERROR`. |
| `API_CONTRACTS.md` Phase 3: `POST /purchases` → `{ item }`; `POST /purchases/:id/returns` → `{ item, purchase }`. | Both also return `warnings`. Similar `warnings` additions on sales, returns, drawings, top-ups, supplies, expenses, capital, transfers, counts, closings. |
| `API_CONTRACTS.md` health example `schemaVersion: 2`. | Now 14. |
| `README.md`: "Phase 1 (foundation) only … features planned for later phases are not available yet." `ARCHITECTURE.md`: "Phase 1" toolchain and a multi-agent ownership table. | All phases are built; README, ARCHITECTURE rewritten. |
| `TASKS.md`: Phases 6–14 "not started", Phase 1–5 "awaiting owner approval"; Wave items "[ ] PR/merge". | All merged (PRs #4–#10 on `main`). Rewritten. |
| `IMPLEMENTATION_STATUS.md` (not edited here): table says "6–14 … not started"; "Known limitations (Phase 1)" says "No business features yet". | Stale; the orchestrator owns this file. |
| `navItems.ts` descriptions (code, not edited): Sales "Record cash sales of goods and services", Drawings "Owner drawings and capital introduced", etc. | Only shown by an unused placeholder page; "services" is wrong for the POS (service products cannot be sold there). |
| `migrations/README.md` 011 section: date-CHECK "known follow-up … planned with the Phase 8 migration". | Done in migration 012; README corrected. |

---

## 2. Internal inconsistencies inside BUSINESS_RULES.md

1. §3 line 43 vs C10 line 212 (see C-1).
2. §1 line 17 (Ice Cream) says the profit figure is "Σ daily profit shares + profit-eligible releases − re-allocations − other costs paid from the Profit Fund ± cash over/short", while §10.6 prints the P&L as "Sales − Materials (allocated) − Electricity (allocated) − Other … ± over/short". §10.6 itself says "(same total)". Consistent, but the first formula is shorter than the first reading suggests. No change needed; noted so nobody "fixes" it.
3. Header line 3 says "Rule IDs R1–R14 come from the independent Financial Logic review", while R-FD and R-RD (owner rules) and C1–C13, P-1, P-2, D1–D4, E1–E5 are also used as IDs. Cosmetic.
4. §12 lists "Audit log for every edit, void, reopen, restore, settings change" (line 193) but the catalog edits, print service type edits and reload-provider rate changes are also audited (code does more than the text; fine). Start-up and manual backups are not audited (text does not require it).
5. C2 is marked removed but §14 and §10.7 still reference it (as "superseded"). Intentional; keep.

---

## 3. Rules that are unimplemented or only partly implemented

| Rule | Status | Evidence |
|---|---|---|
| R13 "negative cash-book balance" warning (§4 line 56) | **Partly.** Missing on voids of sales, print sales, reload sales and EZCash sales (all remove cash). Present elsewhere. | grep of `negativeCashWarnings` in `server/src/services` (no use in `sales.service.ts` void, `printing.service.ts` `voidPrintSale`, `telecom.service.ts` `voidReloadSale`/`voidEzCashSale`). |
| §2 type `expense_refund` | Defined, never written (voids reverse the `expense` type). Not a violation, just an unused type. | `grep expense_refund`: only the database CHECK and a report label. |
| "R13 … service cost > price" warning | Implemented for print sales only (`PRICE_BELOW_COST`). The POS cannot sell services, so "other services" (§1 Shop row: "print/photocopy/other services") have no entry path except a print service type such as `CUSTOM`. | `sales.service.ts` line 111; `printing.service.ts` line 231. |
| §6 "Service types have configurable price and standard cost per page" | Implemented in `print_service_types`; the Settings "Printing defaults" list is a second, unconnected copy (C-8). | |

Everything else in §0–§14 was found implemented as written, including: integer cents and `mulDivRound`; weighted-average costing and the R4 sweep; one movement per stock change with the cache maintained by a trigger; voids as reversal rows with the original business date; returns (C5/C7, R-RD); C13 extra cost; telecom formulas and the example in §5 (rates 600 bp and 80 bp, extra); the Electricity rule E1–E5 (API error `ELECTRICITY_NOT_ALLOWED`, database CHECKs on `expenses.category` and `icecream_payments.category`); cash entry types and book rules (24 types, §2); closings, reopen and `DAY_CLOSED`; the three-fund system including D1–D4, the exactly-once guard, excess cost and the period rule; R-FD and R-RD with their exact messages and error codes; `posted_at` immutability; audit entries with business date and backdated flag; the Backdated report; seeded categories.

---

## 4. Code behaviours not described by any rule (possible hidden decisions)

Each of these was made by an implementer. None contradicts a rule, but the owner has not approved them as rules.

1. **One opening balance per cash book (per fund for Ice Cream).** `ux_capital_opening_balance` (migration 012); API `409 OPENING_BALANCE_EXISTS`. §8 says only "Opening balance entered at go-live". A second starting balance is impossible; correction is void and re-enter. Later cash in is *capital*.
2. **Per-provider reload commission override.** `reload_providers.commission_bp` (NULL = shop default). §5 says "rate snapshotted, default 600 bp" and the Settings screen has one reload rate; the Telecom screen lets the owner set a different rate per provider. **EZCash always uses the shop-wide EZCash rate** (Dialog's own rate is only its reload rate).
3. **Inactive providers:** an inactive provider blocks reload sales and provider top-ups (`409 PROVIDER_INACTIVE`) but not EZCash.
4. **Cash count "expected" amount** = the book's ledger balance counting rows whose **business date is on or before the count date** (not posting order). Backdated entries made after a count therefore change what the same count would have expected.
5. **Closing a day without counting is allowed** (expected is stored, counted is NULL). §8 says "Daily closing per book per date" without requiring a count. Reopen needs a reason of at least 3 characters. Closing a future date is refused (R-FD).
6. **Stocktake mechanics.** A draft holds counted quantities; **completion compares against the live quantity at completion time**, not at count time (a sale between the count and completion changes the difference). Only `draft → completed`, `draft → void`, `completed → void`. Items must be stock products of the stocktake's book.
7. **Opening stock** (§3 only says "no cash, no purchase"): inactive and service products refused; a batch cannot be voided once its stock was sold or used (`OPENING_BATCH_IN_USE`); Excel import is all-or-nothing, max 5 MB and 5,000 rows, and the same file bytes cannot be imported twice while the earlier batch is posted (`IMPORT_ALREADY_COMMITTED`, in addition to `clientRef`). Backdated dates are accepted.
8. **Inactive products:** cannot be sold (`PRODUCT_INACTIVE`) or purchased (`PRODUCT_NOT_STOCKABLE`); can still have stock losses recorded.
9. **Service-kind products cannot be sold in the POS at all** (`PRODUCT_NOT_SELLABLE_YET`); see C-8/§3.
10. **Damaged-return losses cannot be voided on their own** (`DAMAGED_RETURN_LOSS`); they follow the return, and a sale with returns cannot be voided, so a return is permanent.
11. **A purchase line may have value 0** (`lineTotalCents` 0–99,999,999,999); a purchase of total 0 writes no cash entry. §7 says purchases are "always fully paid in cash".
12. **Print sales:** the unit price may be changed per job, including to 0 (up to 10^9 cents); the cost snapshot is always the type's standard cost (the C13 "raise the cost" rule applies to the POS only). An inactive type refuses sales.
13. **Printing supplies** accept any description and amount (1 to 10^12 cents); no link to stock.
14. **Size limits** (all returned as validation errors): amounts up to 10^12 cents on newer tables, quantities 10^6 to 10^9, 100 lines per sale or purchase, 1,000 lines per manual opening-stock entry, 500 per stocktake, 200 Ice Cream item lines, 3,660 days per report.
15. **No limit on how far back a business date may go** (only R-FD caps the future side). Backdated entries are flagged and reported.
16. **Backup policy:** a backup at every start-up, newest 30 start-up/manual kept, newest 10 pre-restore kept; the dashboard marks the newest backup "stale" after 48 hours. §12 mentions audit of restores only.
17. **Dashboard definitions of "sales"**: Shop = goods + print revenue net of returns; Telecom = scratch-card revenue **+ reload commission + EZCash commission** (collections are not sales); Ice Cream = daily sales; Combined = the sum, which can be negative in a month with more returns than sales. Top products = top 5 by gross profit, stock products only. "Days not yet closed" = the 7 days before the dashboard date, from the book's first cash entry on.
18. **Low-stock rule:** active stock product, reorder level above 0, quantity at or below it. §3 has no reorder level at all.
19. **Telecom/Printing/Expense/other forms accept free-text notes** up to 500 characters and void reasons up to 200; nothing in the rules.
20. **Excel exports** of every report and a 15-sheet "export pack" exist; the rules only mention report content.
21. **Valuation as of a past date** is the sum of movements dated up to that date and can show negative quantities after a backdated loss; the report warns `NEGATIVE_STOCK_AS_OF`. §12/R7 says reports follow business date, which this follows, but the negative case is a consequence nobody approved explicitly.
22. **Error wording for electricity differs:** expenses answer "Electricity is paid from the Ice Cream book." (matches E2); Ice Cream payments answer a longer text ("… record the bill as an 'Electricity bill' payment, not as a category."). Only the first is in the rules. Only a category exactly equal to "electricity" (trimmed, any case) is blocked, so "Electrical repair" is allowed (the database CHECK is the same).
23. **Sales return cash entry on a zero refund**: none written. **Purchase void/return**: refund cash entry only when above 0.
24. **Idempotency scope:** a repeated `clientRef` returns the original with `200`; a cart creates one sale per book with the same `clientRef`, and after a void the same `clientRef` returns the void original (`UNIQUE(client_ref, book)`).
25. **Drawings:** goods drawings cannot be Ice Cream (no stock there); cash drawings in any book (Ice Cream names a fund).

---

## 5. Proposed wording changes for BUSINESS_RULES.md (for the orchestrator)

Quotes are exact; replacement text is a proposal. None changes a formula.

1. **§3, line 43** — replace "stocktake gain (current average × qty via `mulDivRound(value, gainQty, qty)`; if qty = 0, an entered unit cost)" with: "stocktake gain (current average via `mulDivRound(value, gainQty, qty)` when the product has both quantity and value; if its quantity is 0 or its value is 0, an entered unit cost, see C10)".
2. **§3, line 47** — replace "("Only 3 in stock — record a purchase or stocktake")" with "(message: "Not enough stock: 3 on hand, 5 needed.")", or ask for the code message to be changed to the quoted wording.
3. **§4, line 53** — replace "Lines processed in id order" with "Lines processed in cart order".
4. **§12, line 199** — replace "(planned migration, see DATABASE_SCHEMA)" with "(migration 004, see DATABASE_SCHEMA)".
5. **§5, line 59** — replace "Reload (daily total per provider: Dialog, Mobitel, Hutch, Airtel)" with "Reload (one or more entries per provider per day; providers Dialog, Mobitel, Hutch, Airtel)", and after "default 600 bp" add "(each provider may carry its own rate; otherwise the shop default applies)".
6. **§5, line 60** — add: "The EZCash rate is the shop-wide EZCash rate (default 80 bp); it does not depend on the provider's reload rate."
7. **§2, line 30** — either delete "`expense_refund`" from the type column, or add a note "(reserved; an expense void reverses the `expense` entry)".
8. **§4, line 56 (R13)** — either add "(returned by every cash-out write; voids of cash-in records, such as a sale, also warn)" and have the code add the missing warnings, or state "(on creates and on voids of cash-in records; not on voids of sales, print sales, reload and EZCash sales)" to match the code today.
9. **§8, line 83** — add: "Only one opening balance per cash book (per fund for Ice Cream) may be posted at a time; a wrong one is voided and entered again. Later money from the owner is capital."
10. **§8, line 84** — add: "Expected cash for a count or closing = the book's ledger balance of all entries with business date on or before the count date. A day may be closed without a count."
11. **§6** — add: "The Printing screen's service types are the only source of print prices and standard costs. (Settings no longer holds a printing price list.)" — only if decision D-1 below removes the Settings tab; otherwise state how the Settings list is used.
12. **§1/§6 (services)** — add one sentence saying how "other services" are sold (today: a print service type such as `CUSTOM`; service-kind products cannot be sold in the POS), or ask for service products to become sellable.
13. **§3** — add "Opening stock may be voided only while the batch's stock has not been sold or used; an Excel file that was already imported cannot be imported again while its batch is posted."
14. **§12** — add "Backups: made at every start-up, kept 30; safety copy before every restore, kept 10."
15. **New short section "Reports and dashboard definitions"** recording items 17 and 18 of §4 above (definition of "sales" per segment, low stock, days not yet closed).

## 6. Decisions needed from the owner

- **D-1 Printing defaults (Settings).** Remove the tab, or make it the source of print prices (and seed or edit the print service types). Today it changes nothing.
- **D-2 Service products in the POS.** Keep refusing them (and say so in the rules and in the message), or allow them with a cost of their own.
- **D-3 Negative-cash warning on voids** of sales, print sales, reload sales and EZCash sales: add the warning, or accept the gap.
- **D-4 Approve or change** the hidden decisions in §4 that affect the owner's daily work (items 1, 2, 4, 5, 6, 8, 17).

## 7. Could not verify

- That every individual test asserts what its name says (the suite passes: 1,681 tests; I did not read all 81 files).
- The browser behaviour of each screen on a clean database through `Start-Viman-Shop.bat`; the owner guide in `README.md` was written from the page source, route table and API, not from a live session.
- The exact on-screen wording of every button and warning (the guide names the main ones; a few labels such as "Reopen" are links inside the closings table).
- Behaviour of the launcher when `node_modules` exists but is incomplete, and the 200 MB upload limit (stated in `IMPLEMENTATION_STATUS.md` as untested).
- `IMPLEMENTATION_STATUS.md` and `AGENT_WORK_LOG.md` were not reviewed line by line (orchestrator-owned); only the "known limitations" and counts were read.
