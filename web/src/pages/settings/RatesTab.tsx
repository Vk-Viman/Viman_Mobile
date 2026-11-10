import { useState } from 'react';
import type { FormEvent } from 'react';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { PercentInput } from '../../components/PercentInput';
import { Spinner } from '../../components/Spinner';
import { ErrorState } from '../../components/ErrorState';
import { useToast } from '../../components/Toast';
import { useSettings, useUpdateSettings } from '../../api/settings';
import type { RateSettings } from '../../types/api';
import { bpToPercent, percentToBp } from '../../lib/units';
import { errorMessage, serverFields } from './formUtils';

type Key = keyof RateSettings;
const LABELS: Record<Key, string> = { reloadCommissionBp: 'Reload commission (%)', ezcashCommissionBp: 'EZCash commission (%)' };

function checkRate(s: string): string | undefined {
  const bp = percentToBp(s);
  if (bp === null) return 'Enter a percentage like 6, 0.8 or 6.25 (up to 2 decimals).';
  if (bp > 10000) return 'Must be between 0 and 100.';
  return undefined;
}

function RatesForm({ initial }: { initial: RateSettings }) {
  const init = { reloadCommissionBp: bpToPercent(initial.reloadCommissionBp), ezcashCommissionBp: bpToPercent(initial.ezcashCommissionBp) };
  const [v, setV] = useState<Record<Key, string>>(init);
  const [touched, setTouched] = useState(false);
  const update = useUpdateSettings();
  const toast = useToast();

  const dirty = v.reloadCommissionBp.trim() !== init.reloadCommissionBp || v.ezcashCommissionBp.trim() !== init.ezcashCommissionBp;
  const server = update.isError ? serverFields(update.error, 'rates') : {};
  const err = (k: Key) => (touched ? checkRate(v[k]) : undefined) ?? server[k];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    const reload = percentToBp(v.reloadCommissionBp);
    const ez = percentToBp(v.ezcashCommissionBp);
    if (checkRate(v.reloadCommissionBp) || checkRate(v.ezcashCommissionBp) || reload === null || ez === null) return;
    update.mutate(
      { rates: { reloadCommissionBp: reload, ezcashCommissionBp: ez } },
      { onSuccess: () => toast.success('Commission rates saved.'), onError: (er) => toast.error(errorMessage(er)) },
    );
  };

  const field = (k: Key, hint: string) => (
    <PercentInput
      label={LABELS[k]}
      value={v[k]}
      onChange={(s) => { update.reset(); setV({ ...v, [k]: s }); }}
      error={err(k)}
      hint={hint}
    />
  );

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {field('reloadCommissionBp', 'Share of each reload kept as commission.')}
        {field('ezcashCommissionBp', 'Share of each EZCash bill payment kept as commission.')}
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={!dirty} loading={update.isPending}>Save changes</Button>
      </div>
    </form>
  );
}

export function RatesTab() {
  const q = useSettings();
  return (
    <Card title="Commission rates" className="max-w-2xl">
      {q.isPending ? <Spinner label="Loading" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <RatesForm key={q.data.updatedAt ?? 'none'} initial={q.data.rates} />
      )}
    </Card>
  );
}
