/**
 * Testy parserów ingestii osób pełniących funkcje publiczne (Demagog: demagog.test.ts) — wyłącznie na fixturach
 * (src/corpus/fixtures/*.sample.*; uproszczone, ale wiernie odwzorowujące strukturę prawdziwych stron). Bez sieci.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commissionRoleGloss, commissionText, mepSentence, parseCollege, parseMepList } from "./eu-leadership";
import { looksLikeBotBlock } from "./factcheck-probe";
import {
  appointmentSentence,
  isHeadOfMission,
  missionSentence,
  parseCsv,
  parseGovBio,
  parseMissionRegister,
  parsePersonList,
  parsePublicationDates,
  positionStems,
} from "./govpl-officials";
import { clubSentence, compositionSentence, mpSentence, parseMarshalSignature, romanTerm, type SejmClub, type SejmMp } from "./sejm-mp";
import { parsePresidentPage, parseSenatePresidium, presidentText, senateRoleLabel } from "./state-officials";

const fx = (name: string) => readFileSync(resolve(fileURLToPath(new URL("../fixtures/", import.meta.url)), name), "utf8");

describe("gov.pl: lista osób, biogram, rejestr placówek", () => {
  it("parsePersonList czyta imię, funkcję i link; pomija wpisy bez funkcji", () => {
    const list = parsePersonList(fx("govpl-council.sample.html"));
    expect(list).toEqual([
      { name: "Jan Przykładowy", position: "Prezes Rady Ministrów", href: "/web/premier/jan-przykladowy" },
      { name: "Anna Testowa", position: "Wiceprezes Rady Ministrów, Minister Spraw Zagranicznych", href: "/web/premier/anna-testowa" },
    ]);
  });

  it("parseGovBio: linie przed blokiem publikacji, data pierwszej publikacji i najnowszej wersji", () => {
    const bio = parseGovBio(fx("govpl-bio.sample.html"));
    expect(bio.lines[0]).toBe("Anna Testowa");
    expect(bio.lines[1]).toBe("Wiceprezes Rady Ministrów, Minister Spraw Zagranicznych");
    expect(bio.lines.some((l) => /Informacje o publikacji|Pierwsza publikacja/.test(l))).toBe(false);
    expect(bio.dates).toEqual({ first: "2023-12-13", latest: "2025-08-11" });
  });

  it("parsePublicationDates: bez historii zmian latest = pierwsza publikacja; bez bloku wszystko null", () => {
    expect(parsePublicationDates("Informacje o publikacji dokumentu\nPierwsza publikacja: 14.12.2018 16:32 Ktoś")).toEqual({ first: "2018-12-14", latest: "2018-12-14" });
    expect(parsePublicationDates("Brak bloku z datami, jest tylko 12.05.2020 w treści")).toEqual({ first: null, latest: null });
  });

  it("appointmentSentence wybiera zdanie o BIEŻĄCEJ funkcji i odrzuca czas przeszły oraz inne stanowiska", () => {
    const bio = parseGovBio(fx("govpl-bio.sample.html"));
    const pos = "Wiceprezes Rady Ministrów, Minister Spraw Zagranicznych";
    expect(appointmentSentence(bio.lines.slice(2), "Anna Testowa", pos)).toBe("Od lipca 2025 roku pełni funkcję Wiceprezesa Rady Ministrów, Ministra Spraw Zagranicznych.");
    // zdanie o poprzednim resorcie nie pasuje do nazwy funkcji → brak zdania
    expect(appointmentSentence(["18 grudnia 2023 roku został powołany na stanowisko sekretarza stanu w Ministerstwie Aktywów Państwowych."], "X", "Minister Nauki i Szkolnictwa Wyższego")).toBeNull();
    // czas przeszły wyklucza
    expect(appointmentSentence(["Od 2024 roku pełnił funkcję sekretarza stanu w Kancelarii Prezesa Rady Ministrów."], "X", "Sekretarz Stanu")).toBeNull();
    // premier: brak znaczących rdzeni → wystarczy zdanie o powołaniu
    expect(appointmentSentence(["13 grudnia 2023 r. objął stanowisko Prezesa Rady Ministrów."], "X", "Prezes Rady Ministrów")).toBe("13 grudnia 2023 r. objął stanowisko Prezesa Rady Ministrów.");
  });

  it("positionStems pomija słowa ogólne", () => {
    expect(positionStems("Minister Nauki i Szkolnictwa Wyższego")).toEqual(["nauki", "szkoln", "wyższe"]);
    expect(positionStems("Prezes Rady Ministrów")).toEqual([]);
  });

  it("parseCsv: separator ;, cudzysłowy ze średnikiem w środku, CRLF", () => {
    expect(parseCsv('a;b;c\r\n1;"x; y";3\r\n')).toEqual([
      ["a", "b", "c"],
      ["1", "x; y", "3"],
    ]);
    expect(parseCsv('"cyt ""w środku""";2')).toEqual([['cyt "w środku"', "2"]]);
  });

  it("rejestr placówek: tylko ambasady i stałe przedstawicielstwa z kierownikiem, zdanie generowane z pól", () => {
    const rows = parseMissionRegister(fx("govpl-register.sample.html"));
    expect(rows).toHaveLength(5);
    const heads = rows.filter(isHeadOfMission);
    expect(heads.map((r) => r.head)).toEqual(["Jan Przykładowy", "Adam Tymczasowy"]);
    expect(missionSentence(heads[0]!)).toBe("Ambasada Rzeczypospolitej Polskiej w Republice Francuskiej (Francja) - kierownik placówki: Jan Przykładowy, stanowisko: Ambasador.");
    // pole zakończone kropką („a.i.”) nie daje podwójnej kropki
    expect(missionSentence(heads[1]!)).toBe("Ambasada Rzeczypospolitej Polskiej w Republice Federalnej Niemiec (Niemcy) - kierownik placówki: Adam Tymczasowy, stanowisko: Chargé d'affaires a.i.");
    expect(missionSentence({ country: "X", mission: "M".repeat(400), head: "A B", headTitle: "Ambasador" }).length).toBeLessThanOrEqual(300);
  });

  it("parseMissionRegister zwraca [] dla strony bez rejestru lub z uszkodzonym JSON", () => {
    expect(parseMissionRegister("<html><body>nic</body></html>")).toEqual([]);
    expect(parseMissionRegister('<pre id="registerData">{nie json</pre>')).toEqual([]);
  });
});

describe("prezydent.pl i Senat", () => {
  it("parsePresidentPage: nagłówek h1 z <header>, zdanie o objęciu urzędu pierwsze, data = ostatnia modyfikacja", () => {
    const p = parsePresidentPage(fx("president.sample.html"))!;
    expect(p.heading).toBe("Dr Jan Testowy – Prezydent Rzeczypospolitej Polskiej");
    expect(p.officeSentences[0]).toBe("Urząd ten objął 6 sierpnia 2025 roku, składając przysięgę przed Zgromadzeniem Narodowym.");
    expect(p.officeSentences[1]).toMatch(/^W drugiej turze wyborów prezydenckich/);
    expect(p.date).toBe("2025-08-06");
    const text = presidentText(p);
    expect(text.split("\n")[0]).toBe(p.heading);
    expect(text).toContain("Urząd ten objął 6 sierpnia 2025 roku");
    expect(text.length).toBeLessThanOrEqual(300);
  });

  it("parsePresidentPage zwraca null bez nagłówka z urzędem Prezydenta", () => {
    expect(parsePresidentPage("<html><body><h1>Inna strona</h1><p>tekst</p></body></html>")).toBeNull();
  });

  it("parseSenatePresidium: tylko Marszałek i wicemarszałkowie, w kolejności strony", () => {
    const m = parseSenatePresidium(fx("senate-presidium.sample.html"));
    expect(m.map((x) => `${x.name}|${x.role}`)).toEqual(["Jan Testowy|Marszałek", "Ewa Przykładowa|Wicemarszałek"]);
    expect(senateRoleLabel("Marszałek")).toBe("Marszałek Senatu");
    expect(senateRoleLabel("Wicemarszałek")).toBe("Wicemarszałek Senatu");
  });
});

describe("UE: Kolegium Komisarzy i posłowie do PE", () => {
  it("parseCollege: grupy, imię i teka (kilka akapitów łączonych), bez kart aktualności po sekcji Composition", () => {
    const c = parseCollege(fx("commission-college.sample.html"));
    expect(c.map((x) => x.name)).toEqual(["Jan Testowy", "Maria Przykładowa", "Piotr Komisarz"]);
    expect(c[0]).toMatchObject({ group: "The President", portfolio: "" });
    expect(commissionText(c[0]!)).toBe("The President Jan Testowy");
    expect(commissionText(c[1]!)).toBe("Maria Przykładowa High Representative for Foreign Affairs and Security Policy");
    expect(c[2]!.portfolio).toBe("Trade and Economic Security Interinstitutional Relations and Transparency");
    expect(commissionRoleGloss(c[0]!)).toMatch(/przewodniczący Komisji Europejskiej/);
    expect(commissionRoleGloss(c[1]!)).toMatch(/wysoki przedstawiciel/);
  });

  it("parseMepList i mepSentence: zdanie z pól API, kod grupy zachowany", () => {
    const json = {
      data: [
        { identifier: "1", givenName: "Jan", familyName: "Eurodeputowany", "api:political-group": "PPE", "api:country-of-representation": "PL" },
        { identifier: "2", givenName: "", familyName: "Bez Imienia", "api:political-group": "ECR", "api:country-of-representation": "PL" },
      ],
    };
    const meps = parseMepList(json);
    expect(meps).toHaveLength(1);
    const s = mepSentence(meps[0]!);
    expect(s).toContain("Jan Eurodeputowany");
    expect(s).toContain("grupa polityczna w PE: PPE (Group of the European People's Party");
    expect(parseMepList(null)).toEqual([]);
  });
});

describe("Sejm: posłowie, kluby, Marszałek", () => {
  const clubs = new Map<string, SejmClub>([
    ["KO", { id: "KO", name: "Klub Parlamentarny Koalicja Obywatelska", membersCount: 2, members: [{ firstName: "Jan", lastName: "Szef", function: "przewodniczący" }, { firstName: "Ewa", lastName: "Zastępca", function: "wiceprzewodnicząca" }, { firstName: "Adam", lastName: "Zwykły" }] }],
  ]);
  const mp = (over: Partial<SejmMp>): SejmMp => ({ id: 1, firstName: "Jan", lastName: "Kowalski", firstLastName: "Jan Kowalski", club: "KO", active: true, districtNum: 13, districtName: "Kraków", voivodeship: "małopolskie", ...over });

  it("mpSentence: poseł aktywny, niezrzeszony i z wygasłym mandatem (z opisem z API)", () => {
    expect(mpSentence(mp({}), clubs, 10)).toBe(
      "Jan Kowalski - poseł/posłanka na Sejm RP X kadencji: klub lub koło poselskie: Klub Parlamentarny Koalicja Obywatelska (KO); okręg wyborczy nr 13 Kraków, województwo małopolskie; mandat poselski aktywny według API Sejmu.",
    );
    expect(mpSentence(mp({ club: "niez." }), clubs, 10)).toContain("poseł niezrzeszony");
    const gone = mpSentence(mp({ active: false, inactiveCause: "Zrzeczenie", mandateExpiryDate: "2025-08-07", waiverDesc: "Powołany na stanowisko Sekretarza Stanu" }), clubs, 10);
    expect(gone).toContain("były poseł/posłanka Sejmu RP X kadencji");
    expect(gone).toContain("mandat jest nieaktywny (wygasł 2025-08-07, przyczyna: zrzeczenie się mandatu; opis w API Sejmu: „Powołany na stanowisko Sekretarza Stanu”)");
    expect(gone).not.toContain("aktywny według API");
  });

  it("clubSentence i compositionSentence liczą z danych API", () => {
    const s = clubSentence(clubs.get("KO")!, 10);
    expect(s).toContain("liczy 2 członków");
    expect(s).toContain("Przewodniczący/przewodnicząca: Jan Szef");
    expect(s).toContain("Wiceprzewodniczący/wiceprzewodnicząca: Ewa Zastępca");
    const comp = compositionSentence([mp({ id: 1 }), mp({ id: 2 }), mp({ id: 3, club: "niez." }), mp({ id: 4, active: false })], 10);
    expect(comp).toContain("mandat poselski sprawuje 3 posłów");
    expect(comp).toContain("łącznie 4 osób, w tym 1 z nieaktywnym mandatem");
    expect(comp).toContain("KO: 2");
    expect(comp).toContain("niezrzeszeni: 1");
    expect(romanTerm(10)).toBe("X");
    expect(romanTerm(9)).toBe("IX");
  });

  it("parseMarshalSignature znajduje linię podpisu (także z rozstrzelonym nagłówkiem PDF) albo zwraca null", () => {
    const pdf = "DZIENNIK USTAW\nO B W IE S Z CZ E N I E\nM AR S ZA ŁK A S EJ MU RZ E C ZY PO S PO LI T EJ\n2. Podany tekst nie obejmuje art. 21.\nMarszałek Sejmu: W. Czarzasty\n\nDziennik Ustaw";
    expect(parseMarshalSignature(pdf)).toEqual({ line: "Marszałek Sejmu: W. Czarzasty", initial: "W", surname: "Czarzasty" });
    expect(parseMarshalSignature("Marszałek Sejmu: M. Kidawa-Błońska")?.surname).toBe("Kidawa-Błońska");
    expect(parseMarshalSignature("O B W IE S Z CZ E N I E Marszałka Sejmu bez podpisu")).toBeNull();
  });
});

describe("sonda blokad", () => {
  it("rozpoznaje strony-blokady CDN/WAF", () => {
    expect(looksLikeBotBlock(403, "<title>Attention Required! | Cloudflare</title>")).toBe("Cloudflare");
    expect(looksLikeBotBlock(200, '<iframe src="/_Incapsula_Resource?SWUDNSAI=31"></iframe>')).toBe("Incapsula");
    expect(looksLikeBotBlock(403, "<H1>Access Denied</H1> errors.edgesuite.net")).toBe("Akamai");
    expect(looksLikeBotBlock(403, "nic")).toMatch(/403/);
    expect(looksLikeBotBlock(200, "<html><body>Normalna strona</body></html>")).toBeNull();
  });
});
