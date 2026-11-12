/**
 * PaymentsTab (route "/ice-cream/payments"): Ice Cream payments - materials, the shop's electricity bill and other costs.
 * API: GET /icecream/payments, POST /icecream/payments, POST /icecream/payments/:id/void (api/icecream.ts).
 *
 * Every payment is money paid OUT of the Ice Cream book from one fund (BUSINESS_RULES 10.2). The "How it counts" column is derived by
 * the server (10.3): a settlement of money already set aside, or - only for another cost paid from the Profit fund - an expense.
 * The electricity bill is a settlement, never an expense (E1, E4). Voiding never deletes: the server keeps the payment (shown as
 * "Void") and posts reversals (R1); a closed day refuses new or voided payments until reopened (R9). Totals count POSTED payments only.
 */
import { useEffect, useState } from 'react';
import { Info, Plus } from 'lucide-react';
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
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { PostedStatusBadge } from '../../components/StatusBadges';
import { useToast } from '../../components/Toast';
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { usePayments, useVoidPayment } from '../../api/icecream';
import { PAGE_SIZE } from '../../lib/constants';
import { formatLKR } from '../../lib/format';
import type { PostedStatus } from '../../types/api';
import type { IceFund } from '../../types/cashbooks';
import type { IcePayment, PaymentKind, PaymentQuery } from '../../types/icecream';
import { PaymentDialog } from './PaymentDialog';
import { ELECTRICITY_NOTE, FUNDS, FUND_LABEL, PAYMENT_KINDS, PAYMENT_KIND_LABEL, notifyIceWarnings } from './shared';

/** The payments screen. */
export function PaymentsTab() {
  const toast = useToast();
  const voidMut = useVoidPayment();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState<'' | PaymentKind>('');
  const [fund, setFund] = useState<'' | IceFund>('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<IcePayment | null>(null);

  useEffect(() => { setPage(0); }, [from, to, kind, fund, status]);

  const query: PaymentQuery = {
    from: from || undefined, to: to || undefined, kind: kind || undefined, fund: fund || undefined, status: status || undefined,
    limit: PAGE_SIZE, offset: page * PAGE_SIZE,
  };
  const list = usePayments(query);
  const filtered = Boolean(from || to || kind || fund || status);

  const columns: Column<IcePayment>[] = [
    {
      key: 'date', header: 'Date',
      render: (p) => <span className="inline-flex flex-wrap items-center gap-2">{p.businessDate}{p.backdated && <Badge tone="amber">Backdated</Badge>}</span>,
    },
    { key: 'kind', header: 'Kind', render: (p) => PAYMENT_KIND_LABEL[p.kind] },
    {
      key: 'what', header: 'What for',
      render: (p) => (<span><span className="font-medium text-slate-900">{p.description}</span>{p.category && <span className="mt-0.5 block text-xs text-slate-500">{p.category}</span>}</span>),
    },
    { key: 'fund', header: 'Paid from', render: (p) => `${FUND_LABEL[p.fund]} fund` },
    { key: 'amount', header: 'Amount (Rs.)', align: 'right', render: (p) => <Money cents={p.amountCents} /> },
    {
      key: 'treat', header: 'How it counts',
      render: (p) => (p.pnlTreatment === 'expense' ? <Badge tone="amber">Expense (from Profit)</Badge> : <Badge tone="neutral">Settlement</Badge>),
    },
    {
      key: 'status', header: 'Status',
      render: (p) => (<span><PostedStatusBadge status={p.status} />{p.status === 'void' && p.voidReason && <span className="mt-1 block text-xs text-slate-500">{p.voidReason}</span>}</span>),
    },
    {
      key: 'act', header: 'Actions',
      render: (p) => (p.status === 'posted' ? <Button variant="ghost" onClick={() => setVoiding(p)} aria-label={`Void payment #${p.id}`}>Void</Button> : null),
    },
  ];

  return (
    <>
      <p className="mb-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">
        <Info size={18} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
        <span>{ELECTRICITY_NOTE}</span>
      </p>
      <Card title="Payments" actions={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Add payment</Button>}>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as '' | PaymentKind)}>
            <option value="">All kinds</option>
            {PAYMENT_KINDS.map((k) => <option key={k} value={k}>{PAYMENT_KIND_LABEL[k]}</option>)}
          </SelectField>
          <SelectField label="Paid from" value={fund} onChange={(e) => setFund(e.target.value as '' | IceFund)}>
            <option value="">All funds</option>
            {FUNDS.map((f) => <option key={f} value={f}>{FUND_LABEL[f]} fund</option>)}
          </SelectField>
          <PostedStatusFilterSelect value={status} onChange={setStatus} />
        </div>

        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading payments" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState title="No payments yet" hint="Record materials, the electricity bill and other costs as you pay them."
            action={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Add payment</Button>} />
        ) : (
          <>
            <p className="mb-3 text-sm font-semibold text-slate-900">
              Total paid (posted): <span className="num">{formatLKR(list.data.totals.amountCents)}</span>
              <span className="font-normal text-slate-500"> for the payments that match these filters; voided ones are not counted.</span>
            </p>
            <DataTable columns={columns} rows={list.data.items} rowKey={(p) => p.id} emptyTitle="No payments match these filters" emptyHint="Try a different date range or clear a filter." />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="payments" onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <PaymentDialog onClose={() => setCreating(false)} />}
      {voiding && (
        <VoidRecordDialog
          title={`Void payment #${voiding.id}`}
          intro={`This cancels the ${formatLKR(voiding.amountCents)} payment of ${voiding.businessDate} (${voiding.description}): the money goes back into the ${FUND_LABEL[voiding.fund]} fund. It cannot be undone.`}
          submitLabel="Void payment"
          pending={voidMut.isPending}
          run={(reason, cb) => voidMut.mutate({ id: voiding.id, reason }, { onSuccess: (r) => { notifyIceWarnings(toast, r.warnings); cb.onSuccess(); }, onError: cb.onError })}
          onDone={() => { toast.success('Payment voided.'); setVoiding(null); }}
          onClose={() => setVoiding(null)}
        />
      )}
    </>
  );
}
