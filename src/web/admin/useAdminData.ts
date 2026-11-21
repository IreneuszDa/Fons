import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ApiError, NETWORK_ERROR_PL } from "../api";
import type { AdminUser } from "./adminApi";

export interface AdminContextValue {
  user: AdminUser;
  /** Called on any 401: the panel goes back to the login view. */
  onUnauthorized: () => void;
}

export const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error("useAdmin poza AdminContext");
  return ctx;
}

export type LoadError = { kind: "forbidden" | "error"; message: string };

/** Maps any thrown error to what a panel shows; 401 is handled by the caller (back to login). */
export function toLoadError(err: unknown): LoadError {
  if (err instanceof ApiError && err.status === 403) return { kind: "forbidden", message: err.messagePl };
  return { kind: "error", message: err instanceof ApiError ? err.messagePl : NETWORK_ERROR_PL };
}

/** Runs an admin action; 401 → login, anything else → a Polish message for the panel. */
export function useAdminAction() {
  const { onUnauthorized } = useAdmin();
  return useCallback(
    async <T,>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: LoadError }> => {
      try {
        return { ok: true, value: await fn() };
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized();
          return { ok: false, error: { kind: "error", message: err.messagePl } };
        }
        return { ok: false, error: toLoadError(err) };
      }
    },
    [onUnauthorized],
  );
}

/** Loads data for a panel; re-runs when `deps` change or reload() is called. */
export function useAdminData<T>(loader: () => Promise<T>, deps: unknown[]) {
  const { onUnauthorized } = useAdmin();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let alive = true;
    setIsLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((d) => {
        if (!alive) return;
        setData(d);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        else setError(toLoadError(err));
      })
      .finally(() => alive && setIsLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, onUnauthorized]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, isLoading, reload };
}
