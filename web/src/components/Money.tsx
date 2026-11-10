import { formatLKR } from '../lib/format';

export function Money({ cents, className = '' }: { cents: number; className?: string }) {
  return (
    <span className={`num whitespace-nowrap ${cents < 0 ? 'text-red-700' : ''} ${className}`}>{formatLKR(cents)}</span>
  );
}
