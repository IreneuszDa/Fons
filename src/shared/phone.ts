/** Phone number normalization shared by the WhatsApp signup endpoint and the web form. */

/**
 * Returns the number in E.164 (`+48500000000`) or null when it is not a plausible phone number.
 * Accepts Polish numbers without the country code (9 digits), spaces, dashes, dots and brackets,
 * the `00` international prefix, and any other country code written with `+` or `00`.
 */
export function normalizePhone(input: string): string | null {
  if (typeof input !== "string" || input.length > 40) return null;
  const compact = input.trim().replace(/[\s().\- ]/g, "").replace(/^00/, "+");
  const phone = /^\d{9}$/.test(compact) ? "+48" + compact : compact;
  if (phone.startsWith("+48") && !/^\+48[1-9]\d{8}$/.test(phone)) return null;
  return /^\+[1-9]\d{6,14}$/.test(phone) ? phone : null;
}

/** Log-safe form of a number: country prefix and the last two digits only (`+48…89`). */
export function maskPhone(phone: string): string {
  return phone.length > 5 ? `${phone.slice(0, 3)}…${phone.slice(-2)}` : "…";
}
