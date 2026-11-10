export const BUSINESS_TZ = 'Asia/Colombo';

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function partsOf(now: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of partsFmt.formatToParts(now)) out[p.type] = p.value;
  return out;
}

export function todayBusinessDate(now: Date = new Date()): string {
  const p = partsOf(now);
  return `${p.year}-${p.month}-${p.day}`;
}

export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Date.UTC maps years 0-99 to 1900-1999; setUTCFullYear avoids that.
  dt.setUTCFullYear(y);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function backupStamp(now: Date = new Date()): string {
  const p = partsOf(now);
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}
