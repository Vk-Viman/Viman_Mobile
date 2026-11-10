import { useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { FormDialog } from '../../components/FormDialog';
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { TextField, inputClass } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { ApiError } from '../../api/client';
import { useCreateSupplier, useSuppliers, useUpdateSupplier } from '../../api/catalog';
import type { Supplier, SupplierUpdate } from '../../types/api';
import { CHECKBOX_CLASS, useDebounced } from './shared';

type StatusFilter = 'active' | 'inactive' | 'all';

export function SuppliersTab() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [dialog, setDialog] = useState<{ supplier: Supplier | null } | null>(null);
  const q = useDebounced(search.trim(), 300);
  const suppliers = useSuppliers({ q: q || undefined, active: status === 'all' ? undefined : status === 'active' });
  const filtered = Boolean(q) || status !== 'active';

  const columns: Column<Supplier>[] = [
    { key: 'name', header: 'Name', render: (s) => <span className="font-medium text-slate-900">{s.name}</span> },
    { key: 'phone', header: 'Phone', render: (s) => s.phone || '—' },
    { key: 'notes', header: 'Notes', className: 'max-w-xs truncate', render: (s) => s.notes || '—' },
    { key: 'status', header: 'Status', render: (s) => <Badge tone={s.active ? 'brand' : 'neutral'}>{s.active ? 'Active' : 'Inactive'}</Badge> },
    {
      key: 'actions',
      header: 'Actions',
      render: (s) => (
        <Button variant="ghost" className="!min-h-8 !px-2" aria-label={`Edit ${s.name}`} onClick={(e) => { e.stopPropagation(); setDialog({ supplier: s }); }}>
          <Pencil size={16} aria-hidden="true" /> Edit
        </Button>
      ),
    },
  ];

  return (
    <>
      <Card title="Suppliers" actions={<Button onClick={() => setDialog({ supplier: null })}><Plus size={16} aria-hidden="true" /> New supplier</Button>}>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <TextField label="Search suppliers" placeholder="Search by name or phone" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" className="sm:col-span-2" />
          <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All</option>
          </SelectField>
        </div>
        {suppliers.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading suppliers" /></div>
        ) : suppliers.isError ? (
          <ErrorState error={suppliers.error} onRetry={() => void suppliers.refetch()} />
        ) : suppliers.data.items.length === 0 && !filtered ? (
          <EmptyState
            title="No suppliers yet — add your first supplier"
            action={<Button onClick={() => setDialog({ supplier: null })}><Plus size={16} aria-hidden="true" /> New supplier</Button>}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={suppliers.data.items}
            rowKey={(s) => s.id}
            emptyTitle="No suppliers match these filters"
            onRowClick={(s) => setDialog({ supplier: s })}
          />
        )}
      </Card>
      {dialog && <SupplierDialog key={dialog.supplier?.id ?? 'new'} supplier={dialog.supplier} onClose={() => setDialog(null)} />}
    </>
  );
}

function SupplierDialog({ supplier, onClose }: { supplier: Supplier | null; onClose: () => void }) {
  const editing = supplier !== null;
  const toast = useToast();
  const create = useCreateSupplier();
  const update = useUpdateSupplier();
  const [name, setName] = useState(supplier?.name ?? '');
  const [phone, setPhone] = useState(supplier?.phone ?? '');
  const [notes, setNotes] = useState(supplier?.notes ?? '');
  const [active, setActive] = useState(supplier?.active ?? true);
  const [err, setErr] = useState<ApiError | Error | null>(null);

  const trimmed = name.trim();
  const errors: Record<string, string> = {};
  if (trimmed.length > 120) errors.name = 'Name can be at most 120 characters.';
  if (phone.trim().length > 30) errors.phone = 'Phone can be at most 30 characters.';
  if (notes.length > 500) errors.notes = 'Notes can be at most 500 characters.';

  const body: SupplierUpdate = {};
  if (supplier) {
    if (trimmed !== supplier.name) body.name = trimmed;
    if (phone.trim() !== supplier.phone) body.phone = phone.trim();
    if (notes !== supplier.notes) body.notes = notes;
    if (active !== supplier.active) body.active = active;
  }
  const valid = trimmed.length >= 1 && Object.keys(errors).length === 0;
  const dirty = !editing || Object.keys(body).length > 0;

  const apiErr = err instanceof ApiError ? err : null;
  const fe = (k: string) => errors[k] ?? apiErr?.fields[k];
  const hasFieldErr = apiErr && ['name', 'phone', 'notes'].some((k) => apiErr.fields[k]);
  const banner = err && !hasFieldErr ? err.message : null;

  const done = () => {
    toast.success(editing ? 'Supplier updated.' : 'Supplier added.');
    onClose();
  };
  const submit = () => {
    setErr(null);
    if (supplier) update.mutate({ id: supplier.id, body }, { onSuccess: done, onError: setErr });
    else create.mutate({ name: trimmed, phone: phone.trim(), notes }, { onSuccess: done, onError: setErr });
  };

  return (
    <FormDialog
      title={editing ? `Edit supplier: ${supplier.name}` : 'New supplier'}
      submitLabel={editing ? 'Save changes' : 'Add supplier'}
      canSubmit={valid && dirty}
      loading={create.isPending || update.isPending}
      error={banner}
      onSubmit={submit}
      onClose={onClose}
    >
      <TextField label="Name *" value={name} onChange={(e) => setName(e.target.value)} error={fe('name')} autoComplete="off" />
      <TextField label="Phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={fe('phone')} autoComplete="off" />
      <div>
        <label htmlFor="supplier-notes" className="mb-1 block text-sm font-medium text-slate-700">Notes</label>
        <textarea id="supplier-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass(fe('notes'))} />
        {fe('notes') && <p className="mt-1 text-sm text-red-600">{fe('notes')}</p>}
      </div>
      {editing && (
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className={CHECKBOX_CLASS} checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
      )}
    </FormDialog>
  );
}
