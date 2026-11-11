// Date helpers (lib/dates.ts) - unit level, no database.
// Protects: the Asia/Colombo business-day rule (R7 business date, R-FD "today" = today in Colombo, UTC+5:30, no DST)
// and the backup file-name stamp. Every report period and the future-date block depend on "today" being right,
// especially between 18:30 and 24:00 UTC when Colombo is already on the next calendar day.

import { describe, it, expect } from 'vitest';
import { todayBusinessDate, isIsoDate, backupStamp } from '../lib/dates.ts';

describe('dates', () => {
  // The shop day rolls over at 18:30 UTC (= midnight in Colombo), not at UTC midnight.
  // Hand check: 18:29:59Z + 5:30 = 23:59:59 the same day; 18:30:00Z + 5:30 = 00:00:00 the next day.
  it('todayBusinessDate uses Asia/Colombo (UTC+5:30)', () => {
    expect(todayBusinessDate(new Date('2026-11-10T19:00:00Z'))).toBe('2026-11-11');
    expect(todayBusinessDate(new Date('2026-11-10T06:00:00Z'))).toBe('2026-11-10');
    expect(todayBusinessDate(new Date('2026-11-10T18:29:59Z'))).toBe('2026-11-10');
    expect(todayBusinessDate(new Date('2026-11-10T18:30:00Z'))).toBe('2026-11-11');
  });
  // Valid calendar dates are accepted (2024 is a leap year, so 29 Feb is real there).
  it.each(['2026-02-28', '2024-02-29'])('isIsoDate true for %s', (s) => {
    expect(isIsoDate(s)).toBe(true);
  });
  // Impossible or badly formatted dates must be refused so they can never become a business date.
  it.each(['2026-02-29', '2026-13-01', '2026-1-01', '', '2026-00-10', '2026-04-31', '2026-01-00'])('isIsoDate false for %j', (s) => {
    expect(isIsoDate(s)).toBe(false);
  });
  // Backup folders are named in shop-local time so the owner can recognise them: 06:00Z = 11:30 Colombo.
  it('backupStamp formats in Colombo time', () => {
    expect(backupStamp(new Date('2026-11-10T06:00:00Z'))).toBe('20261110-113000');
    expect(backupStamp(new Date('2026-11-10T19:00:00Z'))).toBe('20261111-003000');
  });
});
