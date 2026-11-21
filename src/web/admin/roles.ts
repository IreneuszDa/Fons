/** Which panel tabs each role sees (mirrors the server's role checks; the server stays the authority). */
import type { Role } from "./adminApi";

export type AdminTab = "cases" | "metrics" | "exports" | "tokens" | "users" | "cache";

export const TAB_LABEL_PL: Record<AdminTab, string> = {
  cases: "Sprawy",
  metrics: "Metryki",
  exports: "Eksport",
  tokens: "Tokeny API",
  users: "Użytkownicy",
  cache: "Pamięć podręczna",
};

export const ROLE_LABEL_PL: Record<Role, string> = {
  moderator: "Moderator",
  analityk: "Analityk",
  administrator: "Administrator",
};

const TABS: Record<Role, AdminTab[]> = {
  moderator: ["cases"],
  analityk: ["metrics", "exports", "tokens"],
  administrator: ["cases", "metrics", "exports", "tokens", "users", "cache"],
};

export function tabsForRole(role: Role): AdminTab[] {
  return TABS[role] ?? [];
}

/** PATCH /api/admin/cases/:id is allowed for moderator and administrator only. */
export function canEditCases(role: Role): boolean {
  return role === "moderator" || role === "administrator";
}

export function isAdminTab(v: string): v is AdminTab {
  return v in TAB_LABEL_PL;
}

export const CASE_STATUS_PL: Record<string, string> = {
  open: "Otwarta",
  forwarded: "Przekazana",
  closed: "Zamknięta",
};

export const CASE_STATUS_COLOR: Record<string, "blue" | "purple" | "gray"> = {
  open: "blue",
  forwarded: "purple",
  closed: "gray",
};

export const ALERT_STATE_PL: Record<string, string> = {
  none: "brak",
  recommended: "zalecany alert",
  sent: "alert wysłany",
  dismissed: "odrzucony",
};
