/**
 * Button: the app's one standard button, so every action looks and behaves the same.
 * Supports four looks (variants) and a built-in "busy" state used while a request is being sent.
 */
import type { ButtonHTMLAttributes } from 'react';
import { Spinner } from './Spinner';

/** primary = main action, secondary = neutral action, danger = destructive (void/delete), ghost = low emphasis. */
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const styles: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-slate-300 disabled:text-slate-500',
  secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400 disabled:bg-slate-100',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-slate-300 disabled:text-slate-500',
  ghost: 'bg-transparent text-slate-700 hover:bg-slate-100 disabled:text-slate-400',
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /** True while a save/request is in flight: shows a spinner and disables the button so it cannot be double-clicked. */
  loading?: boolean;
}

/**
 * Renders a button. All normal button attributes (onClick, aria-label...) pass through.
 * `type` defaults to "button" (not the browser default "submit") so a button inside a form never submits it
 * by accident; submit buttons must say type="submit" explicitly.
 */
export function Button({ variant = 'primary', loading = false, disabled, className = '', children, type = 'button', ...rest }: Props) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles[variant]} ${className}`}
      {...rest}
    >
      {loading && <Spinner size={16} />}
      {children}
    </button>
  );
}
