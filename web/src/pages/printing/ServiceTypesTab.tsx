/**
 * ServiceTypesTab (route "/services/types"): the price list of every service (printing, photocopying, lamination, phone setup...).
 *
 * Lists every service type with its price and standard cost per page; add a new type or edit name, price, cost and
 * the active flag. API: GET/POST /print-service-types, PUT /print-service-types/:id (api/printing.ts).
 * Rules: a price or cost change never alters past sales (each sale keeps the price and cost it was sold with, R12);
 * a type is never deleted, only switched off; its code never changes. The server enforces all of this.
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { Money } from '../../components/Money';
import { Spinner } from '../../components/Spinner';
import { ActiveBadge } from '../../components/StatusBadges';
import { usePrintServiceTypes } from '../../api/printing';
import type { PrintServiceType } from '../../types/printing';
import { ServiceTypeDialog } from './ServiceTypeDialog';

/** The tab: price list table plus the add / edit dialog. */
export function ServiceTypesTab() {
  const types = usePrintServiceTypes(false);
  // `dialog`: null = closed, 'new' = add form, otherwise the type being edited.
  const [dialog, setDialog] = useState<null | 'new' | PrintServiceType>(null);

  const columns: Column<PrintServiceType>[] = [
    { key: 'code', header: 'Code', render: (t) => <span className="font-mono text-xs text-slate-700">{t.code}</span> },
    { key: 'name', header: 'Service', render: (t) => <span className="font-medium text-slate-900">{t.name}</span> },
    { key: 'price', header: 'Price / page', align: 'right', render: (t) => <Money cents={t.priceCents} /> },
    { key: 'cost', header: 'Standard cost / page', align: 'right', render: (t) => <Money cents={t.costCents} /> },
    { key: 'status', header: 'Status', render: (t) => <ActiveBadge active={t.active} /> },
    { key: 'act', header: 'Actions', render: (t) => <Button variant="ghost" onClick={() => setDialog(t)} aria-label={`Edit ${t.name}`}>Edit</Button> },
  ];

  return (
    <>
      <Card
        title="Service types"
        actions={<Button onClick={() => setDialog('new')}><Plus size={16} aria-hidden="true" /> Add service type</Button>}
      >
        <p className="mb-4 text-sm text-slate-500">
          This is the price list used on the Print & service sales tab. You can add ANY service here (for example phone setup or lamination) with its own price and standard cost. The standard cost is what one unit of the service costs you (for a page: paper, toner, wear); it is copied onto
          every sale, so changing a price or cost here never changes sales you already recorded. Switch a service off to hide it from quick entry.
          The starting prices came from Settings → Printing defaults; from now on this list is the one that counts.
        </p>
        {types.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading service types" /></div>
        ) : types.isError ? (
          <ErrorState error={types.error} onRetry={() => void types.refetch()} />
        ) : types.data.items.length === 0 ? (
          <EmptyState title="No service types" action={<Button onClick={() => setDialog('new')}><Plus size={16} aria-hidden="true" /> Add service type</Button>} />
        ) : (
          <DataTable columns={columns} rows={types.data.items} rowKey={(t) => t.id} />
        )}
      </Card>
      {/* Mounted only while open so each opening starts with a fresh form. */}
      {dialog && <ServiceTypeDialog editing={dialog === 'new' ? null : dialog} onClose={() => setDialog(null)} />}
    </>
  );
}
