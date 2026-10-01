import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Tone = "ok" | "bad";
interface Toast {
  id: number;
  tone: Tone;
  text: string;
}

interface ToastApi {
  ok: (text: string) => void;
  bad: (text: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast outside ToastProvider");
  return ctx;
}

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (tone: Tone, text: string) => {
      const id = nextId++;
      setToasts((ts) => [...ts, { id, tone, text }]);
      setTimeout(() => dismiss(id), tone === "bad" ? 8000 : 4000);
    },
    [dismiss],
  );
  const [api] = useState<ToastApi>(() => ({ ok: (t) => push("ok", t), bad: (t) => push("bad", t) }));

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <span>{t.text}</span>
            <button type="button" className="icon" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
