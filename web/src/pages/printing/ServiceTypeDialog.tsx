/**
 * ServiceTypeDialog: add a service type (printing, photocopying or any other service), or edit an existing one (name, price, standard cost, active).
 * API: POST /print-service-types (new) or PUT /print-service-types/:id (edit) via api/printing.ts.
 * The code (capital letters, digits, underscore; 2-20 characters) is chosen once and can never be changed later.
 * Money is typed in rupees and converted to integer cents with rupeesToCents(); the server re-validates everything.
 */
import { useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { MoneyInput } from '../../components/MoneyInput';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCreatePrintServiceType, useUpdatePrintServiceType } from '../../api/printing';
import { CHECKBOX_CLASS } from '../../lib/constants';
import { errorBanner, fieldError } from '../../lib/errors';
import { centsToRupees, rupeesToCents } from '../../lib/units';
import type { PrintServiceType } from '../../types/printing';
import { MAX_NAME, MAX_UNIT_CENTS } from './shared';

const CODE_RE = /^[A-Z0-9_]{2,20}$/;

/** Add (`editing` null) or edit a service type. Mount only while open so every opening starts fresh. */
export function ServiceTypeDialog({ editing, onClose }: { editing: PrintServiceType | null; onClose: () => void }) {
  const toast = useToast();
  const create = useCreatePrintServiceType();
  const update = useUpdatePrintServiceType();
  const mut = editing ? update : create;

  const [code, setCode] = useState(editing?.code ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [price, setPrice] = useState(editing ? centsToRupees(editing.priceCents) : '');
  const [cost, setCost] = useState(editing ? centsToRupees(editing.costCents) : '');
  const [active, setActive] = useState(editing?.active ?? true);
  const [showErrors, setShowErrors] = useState(false);

  const priceC = rupeesToCents(price);
  const costC = rupeesToCents(cost);
  const codeOk = editing !== null || CODE_RE.test(code);
  const nameOk = name.trim().length >= 1 && name.trim().length <= MAX_NAME;
  const priceOk = priceC !== null && priceC <= MAX_UNIT_CENTS;
  const costOk = costC !== null && costC <= MAX_UNIT_CENTS;
  const canSubmit = codeOk && nameOk && priceOk && costOk && !mut.isPending;

  const submit = () => {
    if (!canSubmit || priceC === null || costC === null) { setShowErrors(true); return; }
    const done = { onSuccess: () => { toast.success(editing ? 'Service type updated.' : 'Service type added.'); onClose(); } };
    if (editing) update.mutate({ id: editing.id, body: { name: name.trim(), priceCents: priceC, costCents: costC, active } }, done);
    else create.mutate({ code, name: name.trim(), priceCents: priceC, costCents: costC }, done);
  };

  const err = mut.error;
  const handled = ['code', 'name', 'priceCents', 'costCents'];
  const moneyHint = 'Rupees, up to 2 decimals (for example 15 or 15.50).';

  return (
    <FormDialog
      title={editing ? `Edit ${editing.name}` : 'Add service type'}
      submitLabel="Save"
      canSubmit={canSubmit}
      loading={mut.isPending}
      error={errorBanner(err, handled)}
      onSubmit={submit}
      onClose={onClose}
    >
      {editing ? (
        <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
          Code <span className="font-mono">{editing.code}</span> cannot be changed. New prices and costs apply to future sales only.
        </p>
      ) : (
        <TextField
          label="Code"
          value={code}
          maxLength={20}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          autoComplete="off"
          spellCheck={false}
          hint="Capital letters, digits and underscore, 2-20 characters (for example POSTER_A3 or LAMINATION). It can never be changed."
          error={fieldError(err, 'code') ?? (showErrors && !codeOk ? 'Use 2-20 capital letters, digits or underscores.' : undefined)}
        />
      )}
      <TextField
        label="Name"
        hint="Any service you offer, for example Phone setup or Lamination. Give it its own price and standard cost."
        value={name}
        maxLength={MAX_NAME}
        onChange={(e) => setName(e.target.value)}
        autoComplete="off"
        error={fieldError(err, 'name') ?? (showErrors && !nameOk ? 'Enter a name.' : undefined)}
      />
      <MoneyInput
        label="Price per unit (Rs.)"
        value={price}
        onChange={setPrice}
        error={fieldError(err, 'priceCents') ?? (showErrors && !priceOk ? moneyHint : undefined)}
      />
      <MoneyInput
        label="Standard cost per unit (Rs.)"
        value={cost}
        onChange={setCost}
        error={fieldError(err, 'costCents') ?? (showErrors && !costOk ? moneyHint : undefined)}
      />
      {editing && (
        <label className="flex items-center gap-2 text-sm text-slate-800">
          <input type="checkbox" className={CHECKBOX_CLASS} checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active (shown in quick entry)
        </label>
      )}
    </FormDialog>
  );
}
