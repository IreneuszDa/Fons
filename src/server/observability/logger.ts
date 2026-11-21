/**
 * Strukturalne logi JSON na stdout: jedna linia = jedno zdarzenie.
 * Zasada: nigdy surowa treść użytkownika ani dane osobowe. Logger jest ostatnią linią obrony:
 * pola o nazwach typowych dla treści są wycinane, a długie napisy skracane.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(fields: LogFields): void;
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

const FORBIDDEN_KEYS = new Set([
  "text", "input", "inputmasked", "inputechomasked", "body", "query", "quote", "excerpt",
  "password", "token", "authorization", "cookie", "message", "stack",
]);
const MAX_STRING = 200;

export function sanitizeFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) continue;
    out[k] = typeof v === "string" && v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  }
  return out;
}

export interface RequestScope {
  reqId: string;
}

/** Identyfikator bieżącego żądania dostępny w całym łańcuchu wywołań (logi, dziennik przebiegów). */
export const requestScope = new AsyncLocalStorage<RequestScope>();

export function currentRequestId(): string | undefined {
  return requestScope.getStore()?.reqId;
}

export type LogSink = (line: string) => void;

export function createLogger(sink: LogSink | null, now: () => Date = () => new Date()): Logger {
  const emit = (level: LogLevel, fields: LogFields): void => {
    if (!sink) return;
    const { reqId: explicit, ...rest } = fields;
    const reqId = explicit ?? currentRequestId();
    const line = JSON.stringify({ ts: now().toISOString(), level, ...(reqId ? { reqId } : {}), ...sanitizeFields(rest) });
    try {
      sink(line);
    } catch {
      /* log nie może zatrzymać obsługi żądania */
    }
  };
  return {
    debug: (f) => emit("debug", f),
    info: (f) => emit("info", f),
    warn: (f) => emit("warn", f),
    error: (f) => emit("error", f),
  };
}

export const stdoutSink: LogSink = (line) => void process.stdout.write(`${line}\n`);

/** Logger bez wyjścia (domyślny w testach). */
export const nullLogger: Logger = createLogger(null);
