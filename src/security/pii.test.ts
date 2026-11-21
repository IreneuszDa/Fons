import { describe, expect, it } from "vitest";
import { ibanValid, isValidIdCard, isValidPesel, luhnValid, maskPii, pseudonymize } from "./pii";

describe("validators", () => {
  it("PESEL checksum and month", () => {
    expect(isValidPesel("44051401359")).toBe(true);
    expect(isValidPesel("02070803628")).toBe(true);
    expect(isValidPesel("44051401358")).toBe(false); // wrong checksum
    expect(isValidPesel("44151401353")).toBe(false); // month 15 invalid
  });
  it("Luhn", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });
  it("IBAN mod-97", () => {
    expect(ibanValid("PL61109010140000071219812874")).toBe(true);
    expect(ibanValid("DE89370400440532013000")).toBe(true);
    expect(ibanValid("PL61109010140000071219812875")).toBe(false);
  });
});

describe("maskPii", () => {
  it("masks a valid PESEL", () => {
    const r = maskPii("Mój PESEL to 44051401359, proszę o pomoc.");
    expect(r.text).toBe("Mój PESEL to [PESEL], proszę o pomoc.");
    expect(r.masked).toBe(true);
    expect(r.kinds).toContain("PESEL");
  });

  it("does not mask an invalid PESEL", () => {
    const r = maskPii("Numer 44051401358 nie jest poprawny.");
    expect(r.text).toBe("Numer 44051401358 nie jest poprawny.");
    expect(r.masked).toBe(false);
  });

  it("masks Polish phone numbers in different formats", () => {
    for (const p of ["+48 601 234 567", "+48601234567", "0048 601-234-567", "601 234 567", "601-234-567", "601234567", "22 123 45 67", "(+48) 501 234 567"]) {
      const r = maskPii(`Zadzwoń: ${p} wieczorem`);
      expect(r.text, p).toBe("Zadzwoń: [TELEFON] wieczorem");
    }
  });

  it("does not mask amounts that look like 3-3-3 groups", () => {
    expect(maskPii("Budżet wynosi 100 000 000 zł.").text).toBe("Budżet wynosi 100 000 000 zł.");
    expect(maskPii("W spisie było 380 000 000 osób.").text).toBe("W spisie było 380 000 000 osób.");
    expect(maskPii("Ustawa z 2024 r. ma 120 artykułów.").masked).toBe(false);
  });

  it.each([
    "Donald Tusk podał, że zarejestrowano 601 234 567 przypadków.",
    "Rafał Trzaskowski podał koszt 44051401359 zł.",
    "W ekspertyzie wskazano 4111111111111111 bajtów danych.",
    "Sprawa KRS 601234567 dotyczy spółki.",
    "Uchwała NRX601234567AB została przyjęta.",
    "Wartość wyniosła 601 234 567.",
    "Numer projektu ABA 300000 figuruje w rejestrze.",
  ])("retains a public figure or reference: %s", (text) => {
    expect(maskPii(text)).toEqual({ text, masked: false, kinds: [] });
  });

  it("masks labeled identifiers alongside names and figures", () => {
    const text = "Donald Tusk podał 601 234 567 zgłoszeń. Telefon: 800\u00a0190\u00a0590, PESEL: 44051401359, dowód osobisty: aba-300000.";
    expect(maskPii(text).text).toBe(
      "Donald Tusk podał 601 234 567 zgłoszeń. Telefon: [TELEFON], PESEL: [PESEL], dowód osobisty: [DOWOD].",
    );
    expect(maskPii("Numer telefonu 601 234 567 złamał wcześniejszy schemat.").text).toContain("[TELEFON]");
  });

  it("masks e-mail", () => {
    expect(maskPii("Pisz na jan.kowalski+news@poczta.example.pl!").text).toBe("Pisz na [EMAIL]!");
  });

  it("masks IBAN (PL, spaced, generic) and bare NRB", () => {
    expect(maskPii("Konto: PL61 1090 1014 0000 0712 1981 2874.").text).toBe("Konto: [IBAN].");
    expect(maskPii("Konto PL61109010140000071219812874").text).toBe("Konto [IBAN]");
    expect(maskPii("IBAN DE89 3704 0044 0532 0130 00 ok").text).toBe("IBAN [IBAN] ok");
    expect(maskPii("Przelew na 61 1090 1014 0000 0712 1981 2874").text).toBe("Przelew na [IBAN]");
  });

  it("does not mask IBAN-like strings with a bad checksum", () => {
    expect(maskPii("PL61109010140000071219812875").masked).toBe(false);
  });

  it("masks payment cards (Luhn)", () => {
    expect(maskPii("Karta 4111 1111 1111 1111 wygasa").text).toBe("Karta [KARTA] wygasa");
    expect(maskPii("Karta 5500-0000-0000-0004").text).toBe("Karta [KARTA]");
    expect(maskPii("Karta 4111 1111 1111 1112").text).not.toContain("[KARTA]");
  });

  it("handles several kinds at once", () => {
    const r = maskPii("PESEL 02070803628, tel. 601 234 567, mail a@b.pl");
    expect(r.text).toBe("PESEL [PESEL], tel. [TELEFON], mail [EMAIL]");
    expect(new Set(r.kinds)).toEqual(new Set(["PESEL", "TELEFON", "EMAIL"]));
  });

  it("leaves ordinary text alone", () => {
    const t = "Inflacja wyniosła 2,8 proc. w 2025 roku, a PKB wzrósł o 3 proc.";
    expect(maskPii(t)).toEqual({ text: t, masked: false, kinds: [] });
  });
});

describe("pseudonymize", () => {
  it("is a stable 32-char hex HMAC, different per pepper and per id", () => {
    const a = pseudonymize("+48601234567", "pepper-1");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(pseudonymize("+48601234567", "pepper-1")).toBe(a);
    expect(pseudonymize("+48601234567", "pepper-2")).not.toBe(a);
    expect(pseudonymize("+48601234568", "pepper-1")).not.toBe(a);
  });

  it("uses USER_ID_PEPPER from config by default", async () => {
    process.env.USER_ID_PEPPER = "test-pepper-from-env";
    process.env.ADMIN_PASSWORD ??= "test-admin-password"; // avoid writing var/admin-password
    const { loadConfig } = await import("../server/config");
    expect(loadConfig({}).userIdPepper).toBe("test-pepper-from-env");
    expect(pseudonymize("abc")).toBe(pseudonymize("abc", loadConfig({ userIdPepper: "test-pepper-from-env" }).userIdPepper));
  });
});

describe("maskPii — częste polskie zapisy (SEC-06)", () => {
  it("telefon komórkowy 3-2-2-2 (spacje i myślniki) i stacjonarny z numerem kierunkowym w nawiasie", () => {
    expect(maskPii("oddzwoń 601 23 45 67 pilnie").text).toBe("oddzwoń [TELEFON] pilnie");
    expect(maskPii("601-23-45-67").text).toBe("[TELEFON]");
    expect(maskPii("(22) 123 45 67").text).toBe("[TELEFON]");
    expect(maskPii("(22)1234567").text).toBe("[TELEFON]");
  });

  it("PESEL w grupach 4-4-3 i 6-5 (spacje, myślniki) — tylko poprawny", () => {
    expect(maskPii("PESEL 4405 1401 359").text).toBe("PESEL [PESEL]");
    expect(maskPii("PESEL 440514-01359").text).toBe("PESEL [PESEL]");
    expect(maskPii("PESEL 4405 1401 358").text).toBe("PESEL 4405 1401 358"); // zła suma kontrolna
  });

  it("numer dowodu osobistego z sumą kontrolną", () => {
    expect(isValidIdCard("ABA300000")).toBe(true);
    expect(isValidIdCard("ABA 300000")).toBe(true);
    expect(isValidIdCard("ABC123456")).toBe(false);
    const r = maskPii("dowód ABA 300000, wydany w Elblągu");
    expect(r.text).toBe("dowód [DOWOD], wydany w Elblągu");
    expect(r.kinds).toContain("DOWOD");
  });

  it("nie niszczy kwot, lat i liczb z twierdzeń", () => {
    for (const t of ["Koszt 1 234 567 zł", "W 2024 roku 12 34 56 78", "rok 2023, 15 000 osób", "kod 500 12 34 56 zł", "2024 2025 2026", "ABC 123456", "NATO 2024"]) {
      expect(maskPii(t).text, t).toBe(t);
    }
  });
});
