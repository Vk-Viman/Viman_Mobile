const group = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** 1234550 -> "Rs. 12,345.50"; -123450 -> "-Rs. 1,234.50". Integer cents only. */
export function formatLKR(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const rupees = Math.trunc(abs / 100);
  const c = abs % 100;
  return `${neg ? '-' : ''}Rs. ${group.format(rupees)}.${String(c).padStart(2, '0')}`;
}

const dtf = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Colombo',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return dtf.format(d);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
