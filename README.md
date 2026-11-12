# Viman Mobile — Shop Management System

## What it is

A shop management program that runs on one PC in the shop. It works fully offline: nothing is sent to the internet and no account or password is needed. It keeps three cash books, **Shop**, **Telecom** and **Ice Cream**, and works out profit for each of them and combined. All business is in cash. It is a fresh start: no old records are imported. The owner enters the opening stock and the opening cash balance of each book once (see Going live below).

Every figure is stored in whole cents and every rule is written down in `BUSINESS_RULES.md`. Records are never edited or deleted. A mistake is corrected by cancelling ("voiding") the record, which adds a reversing entry, and then entering it again. Everything that is changed or cancelled is written to the Audit log.

## First-time setup

1. Install **Node.js 24 LTS** from https://nodejs.org (accept the default options).
2. Double-click `Start-Viman-Shop.bat`.
3. The first run needs the internet once to download the required files, then it builds the screens automatically. This can take a few minutes. Later runs are fast and need no internet.

## Daily use

1. Double-click `Start-Viman-Shop.bat`. It checks Node.js, does not start a second copy if one is already running, installs files on the first run, rebuilds the screens only if they are out of date, and opens the browser when the server answers.
2. The browser opens at http://localhost:4300. Only this PC can open that address.
3. Keep the black window open while you work.
4. To stop, press Ctrl+C in the black window, or just close it.

## Where your data lives

- Database: `data\viman.db` (inside the project folder; the folder is created on the first start). Keep `viman.db-wal` and `viman.db-shm` next to it if they are present.
- Backups: `data\backups\`
- A backup is made automatically every time the program starts. The newest 30 start-up and manual backups are kept.
- Before any restore, a safety copy is made. The newest 10 safety copies are kept.
- To keep the data somewhere else set the environment variable `VIMAN_DATA_DIR` before starting.

## Backups and restore

- Go to **Settings → Backups** and press **Backup now** to make a backup at any time.
- To restore, choose a backup in the list (or choose a `.db` file) and type `RESTORE` to confirm. A safety backup of the current data is taken first, the file is checked (it must be a valid Viman database, it must pass the SQLite integrity check, and it must not come from a newer version of the program), and then it replaces the live data. If anything fails after that point the previous data is put back automatically. An older backup is upgraded to the current version after the restore. Anything entered after the backup was made is not in it. The restore is recorded in the Audit log.
- Tip: copy the `data\backups` folder to a USB drive every week. The Dashboard shows a warning when the newest backup is more than 48 hours old.

## Running the checks (developers)

Run from the project root:

| Command | Purpose |
|---|---|
| `npm run dev:server` | Start the server with auto-restart |
| `npm run dev:web` | Start Vite on port 5173 (proxies `/api` to the server on port 4300) |
| `npm test` | Run the server tests (Vitest; 81 files, 1,681 tests at the last full run) |
| `npm run typecheck` | Type-check server and web |
| `npm run build` | Build the web app into `web/dist` |
| `npm start` | Run the server (serves the built web app) |

Environment variables (read by `server/src/index.ts`): `VIMAN_DATA_DIR` (data folder, default `<project>/data`), `VIMAN_PORT` (default 4300), `VIMAN_HOST` (default `127.0.0.1`, which means only this PC can connect). `Start-Viman-Shop.bat` always opens `http://localhost:4300` in its "already running" branch, so use the default port when starting from the launcher.

Launcher helpers are in `scripts/` (Node version check, rebuild check, open-browser-when-ready).

Documents:

| File | What it holds |
|---|---|
| `BUSINESS_RULES.md` | The approved accounting rules. Authoritative; code follows it. |
| `ARCHITECTURE.md` | Layers, directory map, transactions, ledgers, costing, dates, tests, how to extend. |
| `DATABASE_SCHEMA.md` | Every table, column, constraint and trigger as built (schema version 14). |
| `API_CONTRACTS.md` | Every endpoint: request, response, error codes. |
| `server/src/db/migrations/README.md` | What each migration builds and why. |
| `TASKS.md` | Phase checklist and known limitations. |
| `IMPLEMENTATION_STATUS.md`, `AGENT_WORK_LOG.md` | History of how each phase was built and verified. |

## Going live (first day)

1. **Settings → General**: check the shop name, address, phone and email.
2. **Settings → Commission rates**: reload commission (default 6.00%) and EZCash commission (default 0.80%).
3. **Products**: add your products (and Suppliers if you want them on purchases). Scratch cards are products in the *Scratch Cards* category.
4. **Opening Stock**: enter the stock you already own, by hand or from the Excel template. Use it once.
5. **Cash Books**: for each book press **Set opening balance** with the cash that is in the drawer for that book. For Ice Cream you also choose which fund (Cost, Electricity, Profit) the money belongs to.
6. From then on use the other screens every day, and **Close day** on Cash Books each evening.

## Screens, in plain language

Dates on every form start at today and cannot be later than today. You may choose an earlier date (the entry is marked "backdated" in the Audit log and in the Backdated report). Money is typed in rupees (for example `1,250.50`). Forms that save a record cannot be submitted twice by accident.

**Dashboard.** The home screen. Two cards show *Today* and *This month*: sales and profit for Shop, Telecom, Ice Cream and combined. Other cards show cash in each book, stock value and low-stock products, the Ice Cream funds, days not yet closed, and the newest backup. Four charts (30-day sales and profit, 12-month profit by segment, top products, cash per book) each have a "Show as table" switch. "Show figures as of" picks another date. "Excel export pack" downloads a workbook of the main reports for a date range. The Ice Cream card shows a warning when more was spent than was set aside (see Ice Cream).

**Sales.** *POS* tab: search a product by name or code, add it to the cart, change the quantity or price if needed, and press Save sale. A cart that holds both Shop goods and Telecom scratch cards is saved as two sales, one for each book. The cost per unit fills in by itself from the stock; you may raise it (for example to cover extra cost) but not lower it. A price below the minimum or below cost gives a warning but still saves. You cannot sell more than the quantity in stock. *History* tab: find a sale, open it, **Return items** (resalable items go back to stock at their original cost; damaged items do not, and are counted as a loss) or **Void** the whole sale (type `VOID`; not possible after a return). Service products cannot be sold here: use Printing for print and photocopy jobs and Telecom for reloads and EZCash.

**Products.** *Products*: name, optional code, category, selling price, minimum price, reorder level. A product is a *stock* item (counted) or a *service* item (never counted); this cannot be changed later. Stock quantity cannot be typed in: it comes from purchases, opening stock and stocktakes. *Categories*: the 12 built-in categories cannot be renamed or moved between books; you may add your own. *Suppliers*: names and phone numbers. Nothing is deleted; use "inactive" to hide an item.

**Purchases.** Record goods bought from a supplier: choose the date, supplier, bill number, and for each line the product, the number of packs, the pack size and the total price of the line. The whole bill is paid in cash from the Shop or Telecom cash book (a bill cannot mix Shop and Telecom products; make two). **Return items** sends goods back to the supplier and records the refund. **Void** cancels a whole purchase (type `VOID`) if none of it has been returned and its stock is still on hand.

**Stock.** *Stock on hand*: quantity, value and average cost of each product, for today or an earlier date, with a check that the figures agree with the stock history. *Stocktake*: a count sheet per book; complete it to post the differences (shortage = loss at average cost, surplus = gain at average cost; a surplus on a product with no stock or no value asks for a unit cost). *Stock losses*: damaged, lost or expired goods taken out at average cost. *Personal use*: goods the owner takes for himself, recorded at cost (a drawing, not a sale and not a loss). Each of these can be voided.

**Opening Stock.** For go-live only. *Manual entry*: choose products and enter the quantity with either a unit cost or a total value. *Excel import*: download the template, fill in SKU, quantity and cost, upload it, read the preview (each row is marked OK or shows its problem), then confirm. The import is all or nothing: if any row has a problem nothing is saved. Opening stock adds stock without any cash payment and is not profit. A batch can be voided only while its stock has not been sold or used.

**Printing.** *Print sales*: one button per service type (for example B/W one side Rs 15.00, standard cost Rs 6.50); enter the number of pages; the price can be changed for a single job. Cash goes into the Shop book and the standard cost is charged as the cost of the job. *Service types*: change a type's name, price, standard cost or active flag (past sales do not change). *Supplies*: paper and toner you buy. Supplies are cash out of the Shop book but are **not** a cost in profit; the Printing variance report compares supplies spent with the standard cost charged. Note: the *Printing defaults* tab in Settings is only a stored list and does not change these prices; change prices here.

**Telecom.** *Reloads*: the day's reload sales per provider (Dialog, Mobitel, Hutch, Airtel). The whole amount collected is cash in; your income is the commission (default 6.00% of the sales, plus an optional "extra" amount). Each provider can have its own rate (editor on the same tab). *EZCash*: bill payments collected under Dialog; income is the commission (default 0.80% of the bill total). *Top-ups*: money paid out to a provider for reload credit, or into the EZCash wallet. The Telecom cash book is not meant to match Telecom profit, because reload credit and wallet balances are not tracked. Scratch cards are ordinary products sold in Sales.

**Expenses.** Shop and Telecom running costs: Water, Rent, Internet, Transport, Repairs, Cleaning supplies, Packaging, Stationery, Other. There is no Electricity category: the whole shop's electricity bill is paid from the Ice Cream book (see Ice Cream). Ice Cream costs are not entered here.

**Cash Books.** One tab each for Shop, Telecom and Ice Cream, with a period picker. Each shows the opening balance, money in, money out, closing balance and a ledger with a running balance (Ice Cream also shows its three funds). Actions: **Set opening balance** (once per book, and once per fund for Ice Cream; to correct it, void and enter again), **Count cash** (type what is in the drawer; any difference is posted as cash over/short and needs a note), **Close day** (locks that date for that book) and **Reopen day** (needs a reason; recorded in the Audit log). Anything dated on a closed day, including cancelling an old record, is refused until the day is reopened. A cash book that goes below zero shows a warning but is never blocked.

**Drawings.** *Drawings*: cash the owner takes from a book (Ice Cream: from a chosen fund). Goods taken for personal use appear here too but are entered under Stock → Personal use. *Capital*: money the owner puts into a book (not income). *Transfers*: move cash between books; both sides are recorded together. None of these change profit.

**Ice Cream.** The Ice Cream cash book is split into three funds: **Cost**, **Electricity** and **Profit**. *Daily entries*: enter the day's sales and how much to set aside for cost and for electricity; the rest is that day's profit share (a negative share needs an explicit confirmation). *Payments*: materials, the electricity bill (for the whole shop) and other costs, each paid from a chosen fund. *Fund moves*: move money between funds without any cash moving. Moving Cost or Electricity money into Profit counts as profit only up to what was really left unspent; if you move more, the screen shows the split and asks you to confirm. *Funds*: the three fund balances, the cash book total (they must agree), recognized profit, and a warning with "Excess cost not yet charged" and "Profit after excess cost" when more was spent than was set aside. Fund balances are cash allocations, never income; the recognized profit is the official figure. The full rules are in `BUSINESS_RULES.md` §10.

**Reports.** *Profit & loss* (Shop, Telecom, Ice Cream or Combined), *Cash books*, *Ice Cream* (funds and profit), *Stock* (valuation, movements, losses, product profit, low stock), *Activity* (sales, purchases, drawings, printing variance), *Backdated* (records entered with an earlier date). Pick a period and daily or monthly rows; each report can be downloaded as Excel. Every row uses only the records dated inside its own period.

**Settings.** *General*: shop name, address, phone, email. *Commission rates*: reload and EZCash commission. *Printing defaults*: a stored list of print prices (see the note under Printing). *Backups*: backup now, restore. *Audit log*: who-changed-what history, newest first, with a filter by kind of record.

## Troubleshooting

- **Port 4300 is in use:** the program is probably already running. Look for another black window and use it, or close it and start again.
- **"Node.js 24 or newer is required":** install Node.js 24 LTS from https://nodejs.org, then start again.
- **The build failed:** open a terminal in this folder, run `npm run build`, and read the error. Check the internet connection if the first-time install failed.
- **"The shop database is damaged":** this can happen after a power cut or disk fault. The system refuses to start so nothing is written on top of the damaged file. Follow the steps printed in the black window: rename `data\viman.db` to `viman-damaged.db` (and delete `viman.db-wal` / `viman.db-shm` if present), copy the newest file from `data\backups` into `data`, rename the copy to `viman.db`, and start again. Anything entered after that backup was made must be re-entered.
- **Restore rejected:** the chosen file is not a valid Viman database, it failed the integrity check, or it is from a newer version of the program. Your current data is not changed. Pick a different backup.
- **"That day is closed":** the date you chose was closed on Cash Books. Reopen the day (a reason is required), make the entry, then close it again.
- **A message about future dates:** records cannot be dated after today. Choose today or an earlier date.

## Project status

All planned phases (1 to 13) are built and merged. Phase 14, the final validation and documentation review, is in progress. See `TASKS.md` for the checklist and the known limitations.
