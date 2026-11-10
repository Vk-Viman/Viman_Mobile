import { describe, it, expect } from 'vitest';
import { todayBusinessDate, isIsoDate, backupStamp } from '../lib/dates.ts';

describe('dates', () => {
  it('todayBusinessDate uses Asia/Colombo (UTC+5:30)', () => {
    expect(todayBusinessDate(new Date('2026-11-10T19:00:00Z'))).toBe('2026-11-11');
    expect(todayBusinessDate(new Date('2026-11-10T06:00:00Z'))).toBe('2026-11-10');
    expect(todayBusinessDate(new Date('2026-11-10T18:29:59Z'))).toBe('2026-11-10');
    expect(todayBusinessDate(new Date('2026-11-10T18:30:00Z'))).toBe('2026-11-11');
  });
  it.each(['2026-02-28', '2024-02-29'])('isIsoDate true for %s', (s) => {
    expect(isIsoDate(s)).toBe(true);
  });
  it.each(['2026-02-29', '2026-13-01', '2026-1-01', '', '2026-00-10', '2026-04-31', '2026-01-00'])('isIsoDate false for %j', (s) => {
    expect(isIsoDate(s)).toBe(false);
  });
  it('backupStamp formats in Colombo time', () => {
    expect(backupStamp(new Date('2026-11-10T06:00:00Z'))).toBe('20261110-113000');
    expect(backupStamp(new Date('2026-11-10T19:00:00Z'))).toBe('20261111-003000');
  });
});
