/**
 * Toast: small pop-up notices in the bottom-right corner ("Product saved", error messages).
 * ToastProvider is mounted once in main.tsx; any component then calls `useToast().success(...)` or `.error(...)`.
 * Notices disappear by themselves (errors stay longer so they can be read) or when dismissed.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CheckCircle2, XCircle, X } from 'lucide-react';

type Kind = 'success' | 'error';
interface ToastItem { id: number; kind: Kind; message: string }
/** What components receive from useToast(). */
interface ToastApi { success: (m: string) => void; error: (m: string) => void }

/** How long (ms) a notice stays before disappearing on its own. Errors get longer: they need more reading time. */
const SUCCESS_TOAST_MS = 5000;
const ERROR_TOAST_MS = 10000;

const Ctx = createContext<ToastApi | null>(null);

/** Holds the list of visible notices, draws them, and provides the toast API to everything inside it. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  // Counter for unique notice ids; a ref (not state) because changing it must not cause a re-render.
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (kind: Kind, message: string) => {
      const id = nextId.current++;
      setItems((l) => [...l, { id, kind, message }]);
      window.setTimeout(() => dismiss(id), kind === 'error' ? ERROR_TOAST_MS : SUCCESS_TOAST_MS);
    },
    [dismiss],
  );
  // useMemo gives a stable object, so components using useToast() do not re-render whenever a notice appears.
  const api = useMemo<ToastApi>(() => ({ success: (m) => push('success', m), error: (m) => push('error', m) }), [push]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* Container ignores mouse clicks (pointer-events-none) so it never blocks the page; each notice re-enables them. */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-lg"
          >
            {t.kind === 'success' ? (
              <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-brand-600" aria-hidden="true" />
            ) : (
              <XCircle size={20} className="mt-0.5 shrink-0 text-red-600" aria-hidden="true" />
            )}
            <p className="flex-1 break-words text-sm text-slate-800">{t.message}</p>
            <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="rounded p-1 text-slate-400 hover:text-slate-700">
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** Returns `{ success(message), error(message) }`. Throws if used outside ToastProvider (a programming mistake). */
// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast must be used inside ToastProvider');
  return v;
}
