# Review of the 14 implementation decisions (BUSINESS_RULES.md §13A)

Status: **REVIEW ONLY. Nothing here is approved and no behaviour has been changed.** Each decision stays "awaiting owner confirmation" in `BUSINESS_RULES.md` §13A until the owner decides. Every statement about current behaviour was checked against the code (migrations 001–014, services, routes, screens).

Format per decision: **Current** behaviour · **Example** from daily operation · **If retained** · **Risk** · **Recommendation** · **If you choose differently** (development needed).

---

## 1. One opening balance per cash book (per fund for Ice Cream)
- **Current:** A book can hold one *posted* opening balance (Ice Cream: one per fund). A second one is refused (`OPENING_BALANCE_EXISTS`). A wrong one is voided and entered again (blocked while that day is closed; reopen first). Money you put in later is *Capital*.
- **Example:** Shop starts with Rs 50,000. You typed Rs 5,000 by mistake: void it, enter Rs 50,000. Next month you add Rs 20,000 of your own money: that is Capital, not a second opening balance.
- **If retained:** There is always one clear starting figure per book; the cash-book report shows opening, capital and everything else separately.
- **Risk:** Low. Neither opening balance nor capital is income, so profit is never affected whichever you use. The only risk is mislabelling (recording extra money as an "opening balance" is impossible, so it goes to Capital, which is the right place).
- **Recommendation:** Approve.
- **If different:** Allowing several openings = remove one database index and relax one check (small: ~half a day with tests). Not advised: it makes "what did we start with?" ambiguous.

## 2. Expected cash for counts/closings, and closing without a count
- **Current:** "Expected" = the book's balance of all entries whose business date is on or before the count date. A closing stores that figure as it was at closing time. A day may be closed without counting (the closing then only locks the day). Reopening needs a reason (3+ characters). Closing a future date is refused.
- **Example:** You close Tuesday with Rs 40,000 counted and expected. On Thursday you find a Monday receipt and backdate an expense to Monday (Monday was never closed). Tuesday's closing record still says "books said Rs 40,000", but the ledger now shows Tuesday's balance as Rs 39,500.
- **If retained:** Closings are an honest snapshot of what was known when you closed, and every entry stays traceable; backdated entries are flagged and listed in the Backdated report.
- **Risk:** Medium-low. (a) A closed day can drift from its stored "books said" figure if an *earlier, still-open* day is backdated into. (b) Closing without a count records no variance, so a missed shortage is not caught that day.
- **Recommendation:** Approve. Two optional hardenings I would consider later: warn (or block) when backdating into a day that is earlier than an already-closed day; show "not counted" in the closings list and the dashboard.
- **If different:** "Count required to close" = small (one validation + UI). "No entries before the latest closed day" = small-medium (one rule in the shared closed-day check + tests).

## 3. Per-provider reload rate; EZCash uses the shop-wide rate; inactive providers
- **Current:** Each reload provider may carry its own rate; otherwise the shop default (6.00 %). EZCash always uses the shop EZCash rate (0.80 %) whatever Dialog's reload rate is. An inactive provider blocks reload sales and provider top-ups but not EZCash. Rates are snapshotted on each sale, so changing a rate never changes past sales.
- **Example:** Hutch pays 5.5 %: set Hutch to 5.5 %. A Rs 20,000 Hutch reload earns Rs 1,100. Dialog stays at 6 %.
- **If retained:** Commission matches each provider's real terms.
- **Risk:** Low. A mistyped rate affects only reloads recorded afterwards, is audited, and is visible in the history. Minor oddity: setting Dialog inactive does not stop EZCash (which sits under Dialog).
- **Recommendation:** Approve.
- **If different:** One rate for all providers = remove the override UI and column use (small). Block EZCash when Dialog is inactive = tiny.

## 4. Stocktake compares counted quantities with live stock at completion
- **Current:** A draft stocktake stores the quantities you counted. When you press *Complete*, each difference = counted − quantity on hand *at that moment*; gains/losses are posted then.
- **Example:** You count 10 phone cases at 4:00. At 4:05 a customer buys 1 (system now 9). At 4:10 you press Complete: the system sees counted 10 vs live 9 and posts a **gain of 1**, although the shelf now really holds 9.
- **If retained:** Correct only if nothing is sold or received between counting and completing.
- **Risk:** **Medium** for a busy shop: stock and stock-value errors of exactly the units sold during the count. The cash books are unaffected; profit moves through the Stock adjustments line.
- **Recommendation:** Approve for go-live **with an operating rule**: count and complete when the shop is quiet (or complete immediately after counting). Plan a later improvement: record the expected quantity at the moment each line is counted and adjust for movements after that.
- **If different:** "Expected at count time" = medium (store expected per line, add movements since, UI changes, tests incl. randomized).

## 5. Opening stock rules
- **Current:** Inactive and service products are refused. A batch cannot be voided once its stock has been sold or used. An Excel file that was already imported cannot be imported again while its batch is posted (identical file contents). Imports are all-or-nothing (max 5 MB, 5,000 rows). No cash, purchase or profit effect.
- **Example:** You import 300 rows and one SKU is misspelled: nothing is saved, the preview lists the bad row, you fix the file and import again.
- **If retained:** Opening stock cannot be duplicated by double-clicking or re-importing; mistakes before any sale can be voided cleanly.
- **Risk:** Low. After the stock has started selling, a wrong opening quantity is corrected with a stocktake (a Stock adjustment), not a void.
- **Recommendation:** Approve.
- **If different:** Allowing re-import of the same file = remove the file-hash check (tiny, but removes duplicate protection).

## 6. Inactive products
- **Current:** Inactive products cannot be sold or purchased. Stock losses can still be recorded for them. Deactivation keeps all history; the product can be reactivated.
- **Example:** You discontinue "Old Model Charger". Remaining units can still be written off; they cannot be sold until you reactivate it.
- **If retained:** Retired products cannot be bought or sold by accident.
- **Risk:** Low. One trap: deactivating a product that still has stock leaves that stock unsellable (and still valued) until reactivated.
- **Recommendation:** Approve; consider a warning when deactivating a product that still has stock.
- **If different:** The warning is small (UI only).

## 7. Service products cannot be sold in the POS  ← **detailed analysis requested**
- **Current:** A product of kind *service* is refused on a sale line ("Service products are not sold in the POS. Use Printing for print and photocopy jobs."). Printing and photocopying use the Printing screen: **service types** (you can add any service there: code, name, price, standard cost), sold as print sales into the Shop cash book with a cost snapshot, revenue − standard cost = gross profit; paper/toner purchases are a separate cash-out with no profit effect (R12).
- **Example:** A Rs 500 "phone setup" service. Today it is recorded as a Printing service type (not through the POS) and appears in Shop service revenue.
- **Is the limitation suitable?** For go-live: **yes, mostly.** Every service can already be sold with its own price and standard cost through the Printing screen, and it is reported correctly (Shop services line). What is awkward: (a) a service and goods cannot be on one receipt/cart; (b) the screen is called "Printing", which hides that other services can be added; (c) you can still create a product of kind "service" in Products, which then cannot be sold anywhere (confusing); (d) print sales can be voided but there is no "return" for services.
- **Could other services go through the POS without affecting printing?** Yes. Printing keeps its own tables and screen untouched. A POS service line would need: a new line type on the sale lines (the sale-lines table has a fixed list of allowed line types, so this means rebuilding that table safely), no stock movement, a cost snapshot (from the service's cost), the existing "service sale" cash entry type, rules for returns/voids of service lines, and the report definitions (service revenue/cost lines already exist for Shop). It is a **medium-to-large** change to an immutable ledger area.
- **Options:** **A** keep as is and make it clearer: rename the Printing screen/menu to *Services* (UI text only) and stop offering "service" as a product kind in the product form. **B** add service lines to the POS cart (needs new accounting-rule approval: service cost handling, returns of services, receipts). **C** keep Printing only for printing and add a second "Services" screen (more code, no benefit over A).
- **If retained:** Services are fully supported but through a separate screen.
- **Risk:** Low financially; moderate usability (two receipts for a mixed customer).
- **Recommendation:** **A now**; revisit B only if customers often buy services together with goods. A needs no accounting change and no migration.
- **If different (B):** Medium-large: migration of the sale-lines table, service/route/UI, return rules, report checks, full regression and randomized tests, plus rule approval first.

## 8. Returns are permanent  ← **decision needed; proposal below**
- **Current:** Returns are append-only. A damaged-return loss cannot be voided on its own; a sale that has returns cannot be voided; a wrongly entered return cannot be reversed. (There is no "void return" operation in the system.)
- **Example:** You return **2** units instead of 1 by mistake: Rs 3,000 is refunded from the cash book and 2 units go back to stock. Today there is no undo; the only workaround is a stocktake loss and a cash correction, which distorts profit lines and history.
- **If retained:** History is simple and tamper-proof, but one slip is permanent.
- **Risk:** **Medium** operationally (a return typo permanently misstates stock, cash and profit); no data-integrity risk.
- **Recommendation:** Approve for go-live **only if** you accept the risk of a one-slip return. If you expect return mistakes, approve the proposal below first and I build it before go-live. **Nothing will be implemented until you approve the rules.**

### Proposed rules: "Void a sales return" (for approval; not implemented)
1. **Newest first.** A posted return may be voided only if it is the *newest posted return* of every sale line it touches. (Reason: the last return of a line takes the exact remainder of revenue and cost, C5; voiding an older return while a newer one exists would break that remainder.) To undo an older return, void the newer ones first.
2. **One-way status.** The return becomes *void* (reason required, audited, original record kept). It can never be voided twice (409 `ALREADY_VOID`), repeated clicks are idempotent, and the reversal rows are unique.
3. **Stock (resalable units).** The units that came back into stock leave again. They must still be on hand: if fewer than the returned quantity are in stock (some were resold), the void is **refused** with a clear message. The value removed is the original restored value, limited to the pool value (R4); if that empties the pool, any residual is swept to Stock adjustments, and any difference goes to the Stock adjustments line as already done for purchase returns. Movements are new reversal rows; none is edited or deleted.
4. **Cost and extra cost.** A voided return no longer reduces the sale's cost: the sale's automatic cost **and** extra cost (C13) stand again in full.
5. **Revenue and cash.** A voided return no longer reduces revenue; a **reversal cash entry** (+refund) is posted in the same book with the return's *original business date* (R1), checked against closed days (`DAY_CLOSED`) on that date. Cash and profit therefore return exactly to what they were before the return.
6. **Damaged returns.** The linked loss record is voided together with the return (it has no stock movement). The damaged goods were never restocked, so there is nothing to take out of stock.
7. **Line counts.** The line's returned quantity decreases by the voided quantity, so the line can be returned again correctly. A sale can be voided only when it has **no posted returns**.
8. **Reports.** All reports already read *posted* rows only, so after the void the return period's figures are as if the return had never been recorded; the cash book shows the original refund row and its reversal.
9. **Worked example.** Sale of 4 × Rs 1,500 = Rs 6,000 with automatic cost Rs 700 per unit and extra cost Rs 20 per unit (cost Rs 2,880, profit Rs 3,120). Return 1 unit: refund Rs 1,500, cost reversed Rs 700 + Rs 20, profit shown Rs 2,340. Void the return: cash +Rs 1,500, stock −1 unit (Rs 700), revenue Rs 6,000, cost Rs 2,880 again; profit back to Rs 3,120.
- **If implemented:** medium (a Phase-sized change): migration (status columns and triggers on the return tables and the loss link, returned-quantity rule), service + route + screen button, tests (hand-calculated, randomized, rollback, double-void, closed-day, newest-first, stock-sold-since). Also needs approval of rules 1–9, in particular rule 1 (newest first) and rule 3 (refuse when units were resold).
- **Cheaper alternative (not advised):** "correct by selling again" — breaks the link between sale, cost and returns.

## 9. A purchase line may have value 0 (zero-total purchases write no cash entry)
- **Current:** A purchase line can cost Rs 0 (free or promotional units). A purchase whose total is 0 writes no cash entry. The system warns (does not block) when quantity is entered with value 0.
- **Example:** A supplier gives 5 free chargers with an order. Receive them at Rs 0; they dilute the average cost of that product, so later sales show higher margin.
- **If retained:** Free goods are recorded correctly and honestly.
- **Risk:** Low. A forgotten cost typed as 0 overstates future margin until corrected (the warning helps; a purchase void/return is available while stock is intact).
- **Recommendation:** Approve.
- **If different:** Refusing zero-value lines = tiny change, but blocks free stock.

## 10. No limit on how far back a business date may go
- **Current:** Only future dates are blocked. Backdated entries are allowed, flagged "Backdated" and listed in the Backdated report; closed days stay locked.
- **Example:** On 12 Nov you enter a sale dated 1 Oct that was missed. It changes the October report and appears in the Backdated report.
- **If retained:** Missed entries can always be fixed in the right period.
- **Risk:** Medium-low: a backdated entry into an open past period silently changes that period's profit and stock history (weighted-average costing follows posting order while reports follow business dates). It is audited and flagged.
- **Recommendation:** Approve and review the Backdated report monthly; close days/months you have finished with (a closed day cannot be changed).
- **If different:** A "no entries older than N days" setting = small-medium (setting + check in the shared date validation + tests).

## 11. Backups  ← **detailed recommendation requested**
- **Current:** A backup is made at every start-up and on request; the newest 30 start-up/manual backups are kept; a safety copy is made before every restore and the newest 10 are kept; all are stored on the same PC (`data\backups`). The dashboard warns when the newest backup is older than 48 hours. There is no download or copy-to-folder option; you must copy the folder by hand.
- **Example:** The PC's disk fails or is stolen: the database **and all 40 backups** are lost together.
- **If retained:** Protects against software mistakes and bad restores, not against loss of the PC, disk failure, fire, theft or ransomware.
- **Risk:** **High impact, low probability** — the shop's whole financial history sits in one place.
- **Local-only vs external:** *Local-only:* instant, automatic, simple; one point of failure. *External (USB drive):* survives PC failure and ransomware if unplugged; needs a person to plug it in. *Cloud-synced folder (OneDrive/Google Drive):* off-site and automatic, needs internet and an account, and sends shop financial data to a third party (backups are not encrypted).
- **Recommended solution (for approval):** Settings → Backups gets an **"External backup folder"** setting (a drive/folder path such as `E:\VimanBackups` or a OneDrive folder) and a **"Copy to external folder now"** button. After every backup (start-up and manual) the system copies the finished backup file to that folder automatically (never overwriting, size/checksum verified, newest 30 kept there). If the folder is missing (USB not plugged in) the shop keeps working and shows a clear non-blocking warning; the dashboard backup card shows "External copy: OK / not configured / failed / last copied at …" and warns if no external copy was made for 7 days. Optional: "Download latest backup" button. Operating habit: keep the USB drive plugged in at closing time and swap a second drive off-site weekly.
- **Development if approved:** small-medium: needs somewhere to store the folder path (the settings table only allows three fixed keys, so a small migration is required), a copy step in the backup service, an endpoint, UI, dashboard text, tests (missing drive, read-only drive, name clash, checksum failure, retention).
- **Recommendation:** Approve the current policy **and** the external-folder feature.

## 12. Dashboard and report definitions
- **Current:** *Sales* = Shop goods + print revenue net of returns; Telecom = scratch-card revenue + reload commission + EZCash commission (collections are not sales); Ice Cream = daily sales; Combined = the sum (can be negative in a month with more returns than sales). Low stock = active stock product with a reorder level above 0 and quantity at or below it. "Days not yet closed" = the last 7 days. Past-date stock valuation = movements up to that date (a backdated loss can make an earlier date negative; the report warns).
- **Example:** A Rs 50,000 reload shows as Rs 3,050 of Telecom sales; the cash book shows Rs 50,000 in. A product with reorder level 0 is never flagged low.
- **If retained:** Dashboard "sales" match the commission-only revenue rule and the profit reports.
- **Risk:** Low, but easy to misread: Telecom sales on the dashboard look small next to cash collected; products without a reorder level never appear as low stock.
- **Recommendation:** Approve; set reorder levels for the products that matter; optionally show reload/EZCash collections as a memo line on the dashboard.
- **If different:** Changing the definition of "sales" touches the dashboard and its tests (small); the memo line is small (UI + one number).

## 13. Size limits
- **Current:** Amounts up to Rs 10,000,000,000 (10^12 cents); quantities up to 10^6–10^9 by screen; 100 lines per sale or purchase; 1,000 per manual opening-stock entry; 500 per stocktake; 200 Ice Cream item lines; reports up to 3,660 days.
- **Example:** A 120-line purchase must be recorded as two bills.
- **If retained:** Protects against typos and overflow; far above shop-size use.
- **Risk:** Negligible.
- **Recommendation:** Approve.
- **If different:** Raising a limit is tiny per screen; very large values risk exceeding safe integer range, so any increase needs a check.

## 14. Negative-cash warning (R13)
- **Current:** Every write that removes cash from a book, and every void of cash-in records (sales, print sales, reload, EZCash, capital, counts), returns a clear warning if the book falls below zero; nothing is blocked.
- **Example:** Paying a Rs 5,000 expense when the Shop book holds Rs 3,000 saves with an amber warning.
- **If retained:** A negative cash book is a signal of a missing entry (opening balance, capital, transfer) rather than a reason to stop trading.
- **Risk:** Low. The owner must read the warnings; a negative book persisting is a bookkeeping error to fix.
- **Recommendation:** Approve.
- **If different:** Blocking instead of warning = small, but R13 already says "warning, not block".

---

## Summary of recommendations
Approve as they are: **1, 3, 5, 9, 12, 13, 14**. Approve with a small improvement or operating rule: **2, 4, 6, 10**. Decisions needing your choice: **7** (recommend option A: rename Printing to Services, no accounting change), **8** (approve the "void return" rules above if return mistakes are likely), **11** (recommend adding the external backup folder).
