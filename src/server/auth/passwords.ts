/** Hasła: scrypt z node:crypto, format `scrypt$N$r$p$sól(b64)$skrót(b64)`, porównanie w stałym czasie. */
import { randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from "node:crypto";

export const DEFAULT_SCRYPT_N = 32768; // 2^15, ok. 100 ms
const R = 8;
const P = 1;
const KEY_LEN = 32;
const MAX_N = 1 << 20;

export interface HashOptions {
  /** Koszt scrypt (potęga dwójki). Domyślnie 2^15; testy używają mniejszego. */
  N?: number;
}

function maxmemFor(N: number, r: number): number {
  return 128 * N * r * 2 + 1024 * 1024;
}

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  const opts: ScryptOptions = { N, r, p, maxmem: maxmemFor(N, r) };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function format(N: number, salt: Buffer, key: Buffer): string {
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

function checkN(N: number): number {
  if (!Number.isInteger(N) || N < 2 || N > MAX_N || (N & (N - 1)) !== 0) throw new Error("bad_scrypt_cost");
  return N;
}

export async function hashPassword(password: string, opts: HashOptions = {}): Promise<string> {
  const N = checkN(opts.N ?? DEFAULT_SCRYPT_N);
  const salt = randomBytes(16);
  return format(N, salt, await derive(password, salt, N, R, P));
}

export function hashPasswordSync(password: string, opts: HashOptions = {}): string {
  const N = checkN(opts.N ?? DEFAULT_SCRYPT_N);
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize("NFKC"), salt, KEY_LEN, { N, r: R, p: P, maxmem: maxmemFor(N, R) });
  return format(N, salt, key);
}

interface Parsed {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

export function parseHash(stored: string): Parsed | undefined {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  try {
    checkN(N);
  } catch {
    return undefined;
  }
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 8) return undefined;
  const salt = Buffer.from(parts[4]!, "base64");
  const key = Buffer.from(parts[5]!, "base64");
  if (salt.length < 8 || key.length < 16) return undefined;
  return { N, r, p, salt, key };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.N, parsed.r, parsed.p).catch(() => undefined);
  if (!key || key.length !== parsed.key.length) return false;
  return timingSafeEqual(key, parsed.key);
}

/** Skrót „do niczego” — nieistniejący użytkownik kosztuje tyle samo czasu co błędne hasło. */
const dummyByCost = new Map<number, string>();
export function dummyHash(N: number = DEFAULT_SCRYPT_N): string {
  let h = dummyByCost.get(N);
  if (!h) {
    h = hashPasswordSync(randomBytes(16).toString("hex"), { N });
    dummyByCost.set(N, h);
  }
  return h;
}

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;

export function passwordProblem(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) return `Hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Hasło może mieć najwyżej ${MAX_PASSWORD_LENGTH} znaków.`;
  return undefined;
}
