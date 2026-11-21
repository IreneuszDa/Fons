/** Eksport CSV z neutralizacją formuł (PLAN §6): komórki zaczynające się od = + - @ TAB CR dostają apostrof. */
const DANGEROUS = /^[=+\-@\t\r]/;

export function neutraliseCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  let s = String(value);
  if (DANGEROUS.test(s)) s = `'${s}`;
  return s;
}

export function csvCell(value: unknown): string {
  const s = neutraliseCell(value);
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}
