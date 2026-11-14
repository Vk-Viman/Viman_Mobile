# Manual checklist: testing external backups with a real USB drive

**Status: NOT YET PERFORMED.** Everything below is a procedure for the owner. The external-backup feature has been tested with ordinary folders, simulated failures and a launcher-based run on this PC, but **never with a physical USB drive**. Do not treat it as verified until every box below is ticked and the result is written in the sign-off table at the end.

**Golden rule: the live shop database is never used for restore testing.** Every restore test below happens in a separate test data folder, on a different port, with the USB drive unplugged. The live data folder is `data\` inside the project; the test folder is `C:\VimanRestoreTest` (nothing else).

---

## A. Before you start (live shop, 5 minutes)

- [ ] It is quiet in the shop (no sale in progress). Close the day first if it is evening.
- [ ] Settings → Backups → press **Backup now**. Note the file name of the newest backup (for example `viman-20261114-183000-manual.db`) and its size.
- [ ] Use a USB drive you can erase if needed. Note its drive letter (for example `E:`). Create an empty folder on it: `E:\VimanBackups`.
- [ ] Do not use a folder inside OneDrive, Google Drive, Dropbox, iCloud or Box (the program refuses them).

## B. Create an external backup

- [ ] Settings → Backups → **External backup folder**: type `E:\VimanBackups` → **Save**.
- [ ] Expect the status **Synchronized** (green). If you see "Drive not found" the path is wrong; if "Last copy failed", read the message shown.
- [ ] Press **Copy backup now**. Expect a "copied" or "already on the drive" message.
- [ ] Open `E:\VimanBackups` in File Explorer. You should see files named `viman-YYYYMMDD-HHmmss-startup.db` / `-manual.db`, including the one noted in section A, with the **same size**. There must be no files starting with `.viman-` (temporary files).

## C. Run the SHA-256 verification script (read-only)

In a Command Prompt, in the project folder, with the drive plugged in and the program running:

```
node scripts\verify-external-backup.mjs E:\VimanBackups
```

- [ ] Exit code 0 and every line `ok` (check with `echo %ERRORLEVEL%` straight afterwards; it must print 0).
- [ ] Each copy shows "SHA-256 equals the local copy" or, for old files whose local copy has rotated away, `INFO` (that is normal), and "integrity_check = ok".
- [ ] The last lines show the program's status `ok` and the same folder.
- If it prints `FAIL`, stop: do not rely on the drive. Note the exact line and ask for help. The script never changes anything.

## D. Disconnect and reconnect the drive

- [ ] **Unplug the drive properly** (Windows "Safely remove hardware", then pull it out).
- [ ] Keep working: record one small test sale or expense, then **Backup now**. Nothing should fail; you should see only a warning.
- [ ] Settings → Backups shows **Drive not found** (not "Last copy failed"); the Dashboard shows a drive warning. No error pop-ups, no 500 errors.
- [ ] Leave it unplugged for a few minutes (the system retries every 10 minutes). The Settings page may say "failed N times"; the list of failures must stay short (it does not grow with every retry).
- [ ] Plug the drive back in. If Windows gives it a different letter, set the new path in Settings first.
- [ ] Press **Copy backup now**. Expect the new backups to be copied and the status to return to **Synchronized**; the Dashboard warning disappears.
- [ ] Run the verification script from section C again: exit code 0.
- [ ] (Optional, takes 7+ days) after a week with every backup already on the drive, the status must stay Synchronized, not "Overdue".

## E. Restore into a separate test database (never the live one)

This protects the live data. Follow the order exactly.

1. [ ] Copy one backup file from `E:\VimanBackups` (choose the newest manual one) to `C:\VimanRestoreTest\incoming\` using File Explorer. This is a **copy**; leave the original on the drive.
2. [ ] **Unplug the USB drive now.** A restored database remembers the external folder setting from the day it was backed up; with the drive unplugged the test copy cannot write to your real backup drive.
3. [ ] Close the live shop program (black window: Ctrl+C), or at minimum make sure the test copy uses a different port as shown below. The safest way is to close it.
4. [ ] Start a **second, separate** copy of the program on a throw-away data folder and port. In a Command Prompt in the project folder:
   ```
   set VIMAN_DATA_DIR=C:\VimanRestoreTest\data
   set VIMAN_PORT=4310
   Start-Viman-Shop.bat
   ```
   The browser opens at `http://localhost:4310`. **Check the address bar says 4310.** If it says 4300 you are looking at the live program: close the window and stop.
5. [ ] In that test window go to Settings → Backups → **Restore from file...**, choose `C:\VimanRestoreTest\incoming\<the copied file>` and type `RESTORE`.
6. [ ] Expect "restored". Look at Cash Books and Stock: the figures must equal the figures at the moment of that backup (compare with what you wrote down in section A).
7. [ ] **Refusal test (optional but valuable):** make a damaged file: rename any text file (for example a `.txt` note) to `something.db`. Restore it into the test program: it must refuse with a clear message and the figures must stay unchanged.
8. [ ] Close the test program (Ctrl+C). Delete `C:\VimanRestoreTest` when finished.
9. [ ] Start the live shop normally (no `set` commands in that window; the address must be `http://localhost:4300`) and confirm your figures are unchanged. The drive may be plugged in again.

## F. Proof that the live database was never used

- [ ] The test program ran on port **4310** with data in `C:\VimanRestoreTest\data` (the title of the folder in Task Manager or the black window shows this).
- [ ] After section E the live Cash Books balances, the stock quantities and the newest sale on `http://localhost:4300` are exactly what they were in section A (plus the one small test entry from section D, which you can void).
- [ ] No restore appears in the live **Audit log** (Settings → Audit log) during the test.

## Sign-off (fill in only when it was actually done)

| Step | Done on (date) | By | Result (pass / fail, notes) |
|---|---|---|---|
| A prepare | | | |
| B create external backup | | | |
| C SHA-256 script exit 0 | | | |
| D unplug / replug | | | |
| E restore in test copy | | | |
| F live database untouched | | | |

USB drive model and size: ______________  Windows drive letter: ______

Until this table is complete, the project documents say: **"real USB drive verification: not done."**

## What has already been verified without a USB drive (for context)

Launcher-started run on this PC with a normal folder standing in for the drive: copy, size and SHA-256 verification, never overwriting, folder removed and restored (status Drive not found, then Synchronized), 12 failed attempts adding at most one log row, "Copy backup now" clearing the overdue warning, restoring a copy taken from that folder, and refusal of corrupted, truncated, garbage, stock-inconsistent and missing-index files with the live figures unchanged. A real drive adds things a folder cannot: Windows drive letters changing, slow media, removal during a copy, and exFAT/FAT file-system quirks.
