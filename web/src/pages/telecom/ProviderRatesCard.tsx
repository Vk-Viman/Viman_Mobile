/**
 * ProviderRatesCard: the provider-rate editor inside Telecom > Reloads.
 * Lists Dialog, Mobitel, Hutch and Airtel with their effective commission rate and lets the owner set a provider's
 * own rate (or go back to the shop default from Settings > Rates) and switch a provider off or on.
 * API: GET /reload-providers, PUT /reload-providers/:id (api/telecom.ts). A rate change never alters past sales:
 * each sale keeps the rate it was saved with (section 5). A switched-off provider cannot receive new entries.
 */
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { ErrorState } from '../../components/ErrorState';
import { FormDialog } from '../../components/FormDialog';
import { PercentInput } from '../../components/PercentInput';
import { Spinner } from '../../components/Spinner';
import { ActiveBadge } from '../../components/StatusBadges';
import { useToast } from '../../components/Toast';
import { useReloadProviders, useUpdateProvider } from '../../api/telecom';
import { CHECKBOX_CLASS } from '../../lib/constants';
import { errorBanner, errorMessage } from '../../lib/errors';
import { bpToPercent, percentToBp } from '../../lib/units';
import type { ReloadProvider } from '../../types/telecom';
import { rateLabel } from './shared';

/** Edit form for one provider's rate. Mount only while open so each opening starts fresh. */
function RateDialog({ provider, onClose }: { provider: ReloadProvider; onClose: () => void }) {
  const toast = useToast();
  const update = useUpdateProvider();
  const [useDefault, setUseDefault] = useState(provider.ownCommissionBp === null);
  const [percent, setPercent] = useState(bpToPercent(provider.ownCommissionBp ?? provider.commissionBp));

  // 0 - 100 % in basis points (C11); the server re-checks.
  const bp = percentToBp(percent);
  const bpOk = bp !== null && bp <= 10000;
  const canSubmit = (useDefault || bpOk) && !update.isPending;

  const submit = () => {
    if (!canSubmit) return;
    update.mutate(
      { id: provider.id, body: { commissionBp: useDefault ? null : (bp as number), active: provider.active } },
      { onSuccess: () => { toast.success(`${provider.name} rate saved. Past sales are unchanged.`); onClose(); } },
    );
  };

  return (
    <FormDialog title={`${provider.name} commission rate`} submitLabel="Save rate" canSubmit={canSubmit} loading={update.isPending}
      error={errorBanner(update.error)} onSubmit={submit} onClose={onClose}>
      <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
        The rate is saved with every reload entry when it is recorded, so changing it only affects new entries.
      </p>
      <label className="flex items-center gap-2 text-sm text-slate-800">
        <input type="checkbox" className={CHECKBOX_CLASS} checked={useDefault} onChange={(e) => setUseDefault(e.target.checked)} />
        Use the shop default rate (Settings &gt; Rates)
      </label>
      {!useDefault && (
        <PercentInput label="Commission rate (%)" value={percent} onChange={setPercent}
          error={percent !== '' && !bpOk ? 'Enter a percentage from 0 to 100 with up to 2 decimals.' : undefined} hint="For example 6 or 6.25" />
      )}
    </FormDialog>
  );
}

/** The card with the four providers. */
export function ProviderRatesCard() {
  const toast = useToast();
  const providers = useReloadProviders();
  const update = useUpdateProvider();
  const [editing, setEditing] = useState<ReloadProvider | null>(null);

  const toggle = (p: ReloadProvider) =>
    update.mutate(
      { id: p.id, body: { commissionBp: p.ownCommissionBp, active: !p.active } },
      {
        onSuccess: () => toast.success(`${p.name} switched ${p.active ? 'off' : 'on'}.`),
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const columns: Column<ReloadProvider>[] = [
    { key: 'name', header: 'Provider', render: (p) => <span className="font-medium text-slate-900">{p.name}</span> },
    {
      key: 'rate', header: 'Commission rate', align: 'right',
      render: (p) => <span>{rateLabel(p.commissionBp)}{p.ownCommissionBp === null && <span className="ml-1 text-xs text-slate-500">(shop default)</span>}</span>,
    },
    { key: 'status', header: 'Status', render: (p) => <ActiveBadge active={p.active} /> },
    {
      key: 'act', header: 'Actions',
      render: (p) => (
        <span className="inline-flex gap-1">
          <Button variant="ghost" onClick={() => setEditing(p)} aria-label={`Edit ${p.name} rate`}>Edit rate</Button>
          <Button variant="ghost" onClick={() => toggle(p)} disabled={update.isPending} aria-label={`${p.active ? 'Switch off' : 'Switch on'} ${p.name}`}>
            {p.active ? 'Switch off' : 'Switch on'}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <Card title="Provider rates" className="mb-4">
      {providers.isPending ? (
        <div className="flex justify-center py-8"><Spinner label="Loading providers" /></div>
      ) : providers.isError ? (
        <ErrorState error={providers.error} onRetry={() => void providers.refetch()} />
      ) : (
        <DataTable columns={columns} rows={providers.data.items} rowKey={(p) => p.id} />
      )}
      {editing && <RateDialog provider={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}
