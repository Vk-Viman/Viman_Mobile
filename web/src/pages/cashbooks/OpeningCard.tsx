/**
 * OpeningCard: the opening balances of one cash book with "Set opening balance" and "Void" (Cash Books screen).
 * Data: GET /cashbooks/:book/opening, POST /capital-entries/:id/void (api/cashbooks.ts).
 * The opening balance is the cash the book held when you started (BUSINESS_RULES sections 0, 8, 9): money IN, never revenue.
 * Each book (each fund, for Ice Cream) has one posted opening balance; a wrong one is voided - the original stays in the history
 * and the server posts a reversal (R1) - and entered again. A closed day refuses the void until it is reopened (R9); the server's
 * message says so and is shown as it comes. Voiding takes cash out of the book, so the shared negative-cash warning may follow (R13).
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { ErrorState } from '../../components/ErrorState';
import { Money } from '../../components/Money';
import { PostedStatusBadge } from '../../components/StatusBadges';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { useOpeningBalances, useVoidCapitalEntry } from '../../api/cashbooks';
import { notifyCashWarnings } from '../../lib/cashWarnings';
import { formatLKR } from '../../lib/format';
import { SEGMENT_LABEL, scopeLabel } from '../../lib/segments';
import type { CapitalEntry, CashBook } from '../../types/cashbooks';
import type { StoredSegment } from '../../types/segments';
import { OpeningBalanceDialog } from './OpeningBalanceDialog';
import { FUND_LABEL } from './shared';

/**
 * The opening balances of the book and their actions. Telecom (13D): ONE opening balance per segment - the card lists the selected
 * segment's; on "All Telecom" it lists every segment's (with a Segment column) and nothing can be set there.
 */
export function OpeningCard({ book, segment }: { book: CashBook; segment: StoredSegment | null }) {
  const toast = useToast();
  const openings = useOpeningBalances(book, segment);
  const scope = scopeLabel(book, segment);
  const isTotal = book === 'telecom' && segment === null;
  const isLegacy = segment === 'legacy';
  const voidMut = useVoidCapitalEntry();
  const [setting, setSetting] = useState(false);
  const [voiding, setVoiding] = useState<CapitalEntry | null>(null);

  const columns: Column<CapitalEntry>[] = [
    { key: 'date', header: 'Date', render: (e) => <span className="inline-flex flex-wrap items-center gap-2">{e.businessDate}{e.backdated && <Badge tone="amber">Backdated</Badge>}</span> },
    ...(book === 'icecream' ? [{ key: 'fund', header: 'Fund', render: (e: CapitalEntry) => (e.fund ? FUND_LABEL[e.fund] : '—') }] : []),
    ...(isTotal ? [{ key: 'segment', header: 'Segment', render: (e: CapitalEntry) => (e.segment ? SEGMENT_LABEL[e.segment] : '—') }] : []),
    { key: 'amount', header: 'Amount (Rs.)', align: 'right', render: (e) => <Money cents={e.amountCents} /> },
    { key: 'note', header: 'Note', render: (e) => e.note || '—' },
    {
      key: 'status', header: 'Status',
      render: (e) => (<span><PostedStatusBadge status={e.status} />{e.status === 'void' && e.voidReason && <span className="mt-1 block text-xs text-slate-500">{e.voidReason}</span>}</span>),
    },
    {
      key: 'act', header: 'Actions',
      render: (e) => (e.status === 'posted' ? <Button variant="ghost" onClick={() => setVoiding(e)} aria-label={`Void opening balance #${e.id}`}>Void</Button> : null),
    },
  ];

  const all = openings.data?.items ?? [];
  const everyFundSet = book === 'icecream' && ['cost', 'electricity', 'profit'].every((f) => all.some((e) => e.status === 'posted' && e.fund === f));
  // One posted opening balance per scope: the book (Shop), or the selected Telecom segment. The Telecom total lists many scopes at once.
  const alreadySet = book !== 'icecream' && !isTotal && all.some((e) => e.status === 'posted');

  return (
    <Card title="Opening balance"
      actions={<Button onClick={() => setSetting(true)} disabled={openings.isPending || alreadySet || everyFundSet || isTotal || isLegacy}><Plus size={16} aria-hidden="true" /> Set opening balance</Button>}>
      {openings.isPending ? (
        <div className="flex justify-center py-8"><Spinner label="Loading opening balances" /></div>
      ) : openings.isError ? (
        <ErrorState error={openings.error} onRetry={() => void openings.refetch()} />
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-600">
            The cash the {scope} book held when you started using the system. It is not income.
            {(alreadySet || everyFundSet) && ' It is already set; void it first if it was wrong.'}
            {isTotal && ' Each Telecom segment has its own opening balance: choose a segment above to set one.'}
            {isLegacy && ' This old history takes no new opening balance.'}
          </p>
          <DataTable columns={columns} rows={all} rowKey={(e) => e.id} emptyTitle="No opening balance yet"
            emptyHint="Enter the cash you started with so the book balance is right from day one." />
        </>
      )}
      {setting && <OpeningBalanceDialog book={book} segment={segment} existing={all} onClose={() => setSetting(false)} />}
      {voiding && (
        <VoidRecordDialog
          title={`Void opening balance #${voiding.id}`}
          intro={`This cancels the ${formatLKR(voiding.amountCents)} opening balance of ${voiding.businessDate}${voiding.fund ? ` (${FUND_LABEL[voiding.fund]} fund)` : ''}: the cash is taken out of the ${scopeLabel(voiding.book, voiding.segment)} book. Enter it again afterwards. It cannot be undone.`}
          submitLabel="Void opening balance"
          pending={voidMut.isPending}
          run={(reason, cb) => voidMut.mutate({ id: voiding.id, reason }, { onSuccess: (r) => { notifyCashWarnings(toast, r.warnings); cb.onSuccess(); }, onError: cb.onError })}
          onDone={() => { toast.success('Opening balance voided.'); setVoiding(null); }}
          onClose={() => setVoiding(null)}
        />
      )}
    </Card>
  );
}
