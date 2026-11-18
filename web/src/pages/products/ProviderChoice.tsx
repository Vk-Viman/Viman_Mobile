/**
 * ProviderChoice: the provider picker of a Telecom category (BUSINESS_RULES 13D). The provider (Dialog, Mobitel, Airtel or Hutch)
 * decides which Cards segment the category's products stock and sell in, so the server locks it once the category has products.
 * Used by the category dialog and by the "new category" part of the product dialog. Presentation only: the server validates.
 */
import { SelectField } from '../../components/SelectField';
import { useCatalogProviders } from '../../api/catalog';

interface Props {
  label?: string;
  /** Chosen provider id as text; '' = none. */
  value: string;
  onChange: (providerId: string) => void;
  /** Greyed out (the category already has products). */
  disabled?: boolean;
  /** True when a provider must be chosen (a card product is being created); the empty option then reads "Choose a provider…". */
  required?: boolean;
  error?: string;
  hint?: string;
}

/** Drop-down of the four providers. */
export function ProviderChoice({ label = 'Provider', value, onChange, disabled, required, error, hint }: Props) {
  const providers = useCatalogProviders();
  return (
    <SelectField
      label={required ? `${label} *` : label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || providers.isPending}
      error={error ?? (providers.isError ? 'Could not load the providers.' : undefined)}
      hint={hint}
    >
      <option value="">{required ? 'Choose a provider…' : 'No provider (services only)'}</option>
      {(providers.data ?? []).map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
    </SelectField>
  );
}
