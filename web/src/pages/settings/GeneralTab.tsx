/**
 * Settings > General tab (route "/settings"): edit the shop's name, address, phone and email.
 * API: GET /settings (load) and PUT /settings with only the `shop` section (save), via api/settings.ts.
 * The shop name also appears in the top bar of every screen (AppLayout), which updates after a save because the
 * settings cache is refreshed with the server's reply.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { Spinner } from '../../components/Spinner';
import { ErrorState } from '../../components/ErrorState';
import { useToast } from '../../components/Toast';
import { useSettings, useUpdateSettings } from '../../api/settings';
import type { ShopSettings } from '../../types/api';
import { errorMessage, serverFields } from './formUtils';

/** Field length limits, matching the server's validation (the server still re-checks everything). */
const MAX_NAME = 100;
const MAX_ADDRESS = 200;
const MAX_PHONE = 30;
const MAX_EMAIL = 100;

/** Returns a message per invalid field (an empty object means the form is valid). Quick checks for fast feedback. */
function validate(v: ShopSettings): Partial<Record<keyof ShopSettings, string>> {
  const e: Partial<Record<keyof ShopSettings, string>> = {};
  const name = v.name.trim();
  if (name.length < 1) e.name = 'Shop name is required.';
  else if (name.length > MAX_NAME) e.name = `Shop name must be ${MAX_NAME} characters or fewer.`;
  if (v.address.length > MAX_ADDRESS) e.address = `Address must be ${MAX_ADDRESS} characters or fewer.`;
  if (v.phone.length > MAX_PHONE) e.phone = `Phone must be ${MAX_PHONE} characters or fewer.`;
  if (v.email.length > MAX_EMAIL) e.email = `Email must be ${MAX_EMAIL} characters or fewer.`;
  else if (v.email !== '' && !v.email.includes('@')) e.email = 'Email must contain @.';
  return e;
}

/**
 * The editable form. `initial` is the saved value; the form keeps its own draft copy while the owner types.
 */
function ShopForm({ initial }: { initial: ShopSettings }) {
  const [v, setV] = useState<ShopSettings>(initial);
  // Errors are hidden until the first Save attempt so the owner is not scolded while still typing.
  const [touched, setTouched] = useState(false);
  const update = useUpdateSettings();
  const toast = useToast();
  // Save is enabled only when something actually changed.
  const dirty = (Object.keys(initial) as (keyof ShopSettings)[]).some((k) => initial[k] !== v[k]);
  const local = validate(v);
  const server = update.isError ? serverFields(update.error, 'shop') : {};
  // Local message first; otherwise whatever the server reported for the same field.
  const err = (k: keyof ShopSettings) => (touched ? local[k] : undefined) ?? server[k];

  // Returns an onChange handler for one field. Editing clears the previous server error (update.reset()).
  const set = (k: keyof ShopSettings) => (e: { target: { value: string } }) => {
    update.reset();
    setV({ ...v, [k]: e.target.value });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(local).length > 0) return;
    update.mutate(
      { shop: { ...v, name: v.name.trim() } },
      {
        onSuccess: () => toast.success('Shop details saved.'),
        onError: (er) => toast.error(errorMessage(er)),
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <TextField label="Shop name" value={v.name} onChange={set('name')} error={err('name')} maxLength={MAX_NAME} />
      <TextField label="Address" value={v.address} onChange={set('address')} error={err('address')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Phone" value={v.phone} onChange={set('phone')} error={err('phone')} />
        <TextField label="Email" type="email" value={v.email} onChange={set('email')} error={err('email')} />
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={!dirty} loading={update.isPending}>Save changes</Button>
      </div>
    </form>
  );
}

/** The tab: loading spinner, error with retry, or the form. */
export function GeneralTab() {
  const q = useSettings();
  return (
    <Card title="Shop details" className="max-w-2xl">
      {q.isPending ? <Spinner label="Loading" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        // key = last-saved time: after a save the server's updatedAt changes, which remounts the form so its
        // "unchanged" baseline (and the Save button state) matches what was just stored.
        <ShopForm key={q.data.updatedAt ?? 'none'} initial={q.data.shop} />
      )}
    </Card>
  );
}
