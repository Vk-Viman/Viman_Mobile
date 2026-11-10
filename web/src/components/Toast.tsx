import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CheckCircle2, XCircle, X } from 'lucide-react';

type Kind = 'success' | 'error';
interface ToastItem { id: number; kind: Kind; message: string }
interface ToastApi { success: (m: string) => void; error: (m: string) => void }

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (kind: Kind, message: string) => {
      const id = nextId.current++;
      setItems((l) => [...l, { id, kind, message }]);
      window.setTimeout(() => dismiss(id), kind === 'error' ? 10000 : 5000);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(() => ({ success: (m) => push('success', m), error: (m) => push('error', m) }), [push]);

  return (
    <Ctx.Provider value={api}>
      {children}
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

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast must be used inside ToastProvider');
  return v;
}
