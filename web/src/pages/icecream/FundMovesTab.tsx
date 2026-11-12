/**
 * FundMovesTab (route "/ice-cream/moves"): move money between the Cost, Electricity and Profit funds, with history.
 * API: GET /icecream/fund-moves, POST /icecream/fund-moves(/preview), POST /icecream/fund-moves/:id/void (api/icecream.ts).
 *
 * A move changes how the Ice Cream cash is split between the funds and moves no cash in or out of the book (BUSINESS_RULES 10.2).
 * What it does to the recognized profit is decided by the server (10.3): a release to Profit adds the profit-eligible part, a charge
 * back from Profit lowers profit by the full amount (D1), and a Cost / Electricity move leaves profit unchanged. A release bigger
 * than the profit-eligible amount asks for the owner's confirmation in plain words first (D4). Voiding never deletes (R1); the
 * server refuses to void a charge-back or re-label that released profit depends on (D2) and says so. Totals count POSTED moves only.
 */
import { useEffect, useState } from 'react';
import { ArrowRight, Info, Plus } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { DateRangeFields, PostedStatusFilterSelect } from '../../components/FilterFields';
import { Money } from '../../components/Money';
import { Pager } from '../../components/Pager';
import { Spinner } from '../../components/Spinner';
import { PostedStatusBadge } from '../../components/StatusBadges';
import { useToast } from '../../components/Toast';
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { useMoves, useVoidMove } from '../../api/icecream';
import { PAGE_SIZE } from '../../lib/constants';
import { formatLKR } from '../../lib/format';
import type { PostedStatus } from '../../types/api';
import type { IceMove, MoveQuery } from '../../types/icecream';
import { MoveDialog } from './MoveDialog';
import { FUND_LABEL, MOVE_KIND_LABEL, notifyIceWarnings } from './shared';

/** What a posted move did to the profit and the cost charge, in a few words. */
function EffectText({ m }: { m: IceMove }) {
  if (m.kind === 'release') {
    return (
      <span>
        <span className="block">Counts as profit: <Money cents={m.profitEffectCents} /></span>
        {m.cashOnlyCents > 0 && <span className="block text-xs text-slate-500">Cash only (not profit): {formatLKR(m.cashOnlyCents)}</span>}
      </span>
    );
  }
  if (m.kind === 'reallocation') return <span>Recognized profit lowered by <Money cents={-m.profitEffectCents} /></span>;
  return <span>Profit unchanged; cost charge moved: <Money cents={m.chargeRelabelCents} /></span>;
}

/** The fund moves screen. */
export function FundMovesTab() {
  const toast = useToast();
  const voidMut = useVoidMove();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<IceMove | null>(null);

  useEffect(() => { setPage(0); }, [from, to, status]);

  const query: MoveQuery = { from: from || undefined, to: to || undefined, status: status || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
  const list = useMoves(query);
  const filtered = Boolean(from || to || status);

  const columns: Column<IceMove>[] = [
    {
      key: 'date', header: 'Date',
      render: (m) => <span className="inline-flex flex-wrap items-center gap-2">{m.businessDate}{m.backdated && <Badge tone="amber">Backdated</Badge>}</span>,
    },
    {
      key: 'move', header: 'Move',
      render: (m) => (
        <span>
          <span className="inline-flex items-center gap-1 font-medium text-slate-900">{FUND_LABEL[m.fromFund]} <ArrowRight size={14} aria-hidden="true" /> {FUND_LABEL[m.toFund]}</span>
          <span className="mt-0.5 block text-xs text-slate-500">{MOVE_KIND_LABEL[m.kind]}{m.note && ` - ${m.note}`}</span>
        </span>
      ),
    },
    { key: 'amount', header: 'Amount (Rs.)', align: 'right', render: (m) => <Money cents={m.amountCents} /> },
    { key: 'effect', header: 'What it did', render: (m) => <EffectText m={m} /> },
    {
      key: 'status', header: 'Status',
      render: (m) => (<span><PostedStatusBadge status={m.status} />{m.status === 'void' && m.voidReason && <span className="mt-1 block text-xs text-slate-500">{m.voidReason}</span>}</span>),
    },
    {
      key: 'act', header: 'Actions',
      render: (m) => (m.status === 'posted' ? <Button variant="ghost" onClick={() => setVoiding(m)} aria-label={`Void move #${m.id}`}>Void</Button> : null),
    },
  ];

  return (
    <>
      <p className="mb-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">
        <Info size={18} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
        <span>
          Moves only re-divide the Ice Cream cash between the three funds. Moving unspent Cost or Electricity money into Profit adds it to the recognized profit;
          moving money from Profit back to Cost or Electricity lowers the recognized profit by the same amount.
        </span>
      </p>
      <Card title="Fund moves" actions={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Move money</Button>}>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <PostedStatusFilterSelect value={status} onChange={setStatus} />
        </div>

        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading fund moves" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState title="No fund moves yet" hint="Move money between the Cost, Electricity and Profit funds when you want to set it aside differently."
            action={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Move money</Button>} />
        ) : (
          <>
            <p className="mb-3 text-sm font-semibold text-slate-900">
              Posted moves: <span className="num">{formatLKR(list.data.totals.amountCents)}</span> moved, effect on recognized profit <span className="num">{formatLKR(list.data.totals.profitEffectCents)}</span>
              <span className="font-normal text-slate-500"> for the moves that match these filters; voided ones are not counted.</span>
            </p>
            <DataTable columns={columns} rows={list.data.items} rowKey={(m) => m.id} emptyTitle="No fund moves match these filters" emptyHint="Try a different date range or clear a filter." />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="moves" onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <MoveDialog onClose={() => setCreating(false)} />}
      {voiding && (
        <VoidRecordDialog
          title={`Void move #${voiding.id}`}
          intro={`This cancels the ${formatLKR(voiding.amountCents)} move of ${voiding.businessDate} from the ${FUND_LABEL[voiding.fromFund]} fund to the ${FUND_LABEL[voiding.toFund]} fund: the money goes back. `
            + 'If released profit depends on it, the server will refuse - reverse that release first. It cannot be undone.'}
          submitLabel="Void move"
          pending={voidMut.isPending}
          run={(reason, cb) => voidMut.mutate({ id: voiding.id, reason }, { onSuccess: (r) => { notifyIceWarnings(toast, r.warnings); cb.onSuccess(); }, onError: cb.onError })}
          onDone={() => { toast.success('Fund move voided.'); setVoiding(null); }}
          onClose={() => setVoiding(null)}
        />
      )}
    </>
  );
}
