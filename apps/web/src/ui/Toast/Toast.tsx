import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../lib/icons";
import { cx } from "../cx";
import styles from "./Toast.module.css";

export interface ToastOptions {
  tone?: "info" | "ok" | "warn" | "danger";
  /** How long it stays, in milliseconds. */
  ms?: number;
}

interface ToastItem {
  id: number;
  message: string;
  tone: NonNullable<ToastOptions["tone"]>;
}

type Show = (message: string, options?: ToastOptions) => void;

/** Outside a provider (a component test, say) a toast goes nowhere. */
const ToastContext = createContext<Show>(() => {});

const icons = {
  info: <Icon name="ui.info" fallback="💡" />,
  ok: <Icon name="ui.ok" fallback="✅" />,
  warn: <Icon name="ui.warning" fallback="⚠️" />,
  danger: <Icon name="ui.warning" fallback="⚠️" />,
};

/** `show("Saved")`: a short message that appears in the bottom right and goes by itself. */
export function useToast(): Show {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const live = timers.current;
    return () => live.forEach(clearTimeout);
  }, []);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback<Show>(
    (message, options = {}) => {
      const id = next.current++;
      setItems((all) => [...all.slice(-2), { id, message, tone: options.tone ?? "info" }]);
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        dismiss(id);
      }, options.ms ?? 6000);
      timers.current.add(timer);
    },
    [dismiss],
  );
  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.stack} role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx(styles.toast, styles[t.tone])}>
            <span aria-hidden="true">{icons[t.tone]}</span>
            <span className={styles.message}>{t.message}</span>
            <button type="button" className={styles.close} onClick={() => dismiss(t.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
