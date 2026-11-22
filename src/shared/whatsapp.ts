export function normalizeWhatsAppPhone(input: string): string | null {
  if (input.length > 40) return null;
  const compact = input.trim().replace(/[\s().-]/g, "").replace(/^00/, "+");
  const phone = /^\d{9}$/.test(compact) ? "+48" + compact : compact;
  if (phone.startsWith("+48") && !/^\+48[1-9]\d{8}$/.test(phone)) return null;
  return /^\+[1-9]\d{6,14}$/.test(phone) ? phone : null;
}

export type WhatsAppSignupStatus = "pending" | "sent" | "recently_sent";

export function isWhatsAppSignupStatus(value: unknown): value is WhatsAppSignupStatus {
  return value === "pending" || value === "sent" || value === "recently_sent";
}
