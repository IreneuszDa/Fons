import type { ConversationDecision } from "../../engine/llm/conversation";
import type { EngineRequest } from "../context";
import { foldWords } from "../util";

type ImageFocus = NonNullable<EngineRequest["imageFocus"]>;

export function obviousImageFocus(req: EngineRequest): ImageFocus | undefined {
  const caption = foldWords(req.text ?? "");
  if (!caption) return req.imageOptions?.searchWeb ? "copies" : "claims";
  if (/^(?:(?:pokaz|podaj|odczytaj|sprawdz|przeanalizuj) )?(?:metadane|parametry techniczne)(?: (?:tego |tej )?(?:obrazu|zdjecia|fotografii|pliku))?$/.test(caption)) return "origin";
  if (/^(?:gdzie (?:wczesniej |jeszcze )?(?:opublikowano|publikowano) (?:to zdjecie|ten obraz)|znajdz (?:wczesniejsze )?kopie (?:tego zdjecia|tego obrazu))\b/.test(caption)) return "copies";
  if (/^(?:(?:kiedy|gdzie|gdzie i kiedy|kiedy i gdzie) (?:wykonano|zrobiono) (?:to zdjecie|te fotografie)|(?:co to za|jakie to) wydarzenie)\b/.test(caption)) return "context";
  if (/\bdemagog\w*\b/.test(caption) && /\b(?:sprawdz\w*|weryfik\w*|zweryfik\w*|oceni\w*)\b/.test(caption)) return "claims";
  if (/^(czy (to|to jest) ai|czy to ai generated|is this ai generated|sprawdz pochodzenie (obrazu|zdjecia))$/.test(caption)
    || /^czy (ten obraz|to zdjecie|ta grafika) (jest |zostal[oa]? )?(wygenerowan[yae]|stworzon[yae]) przez (ai|sztuczna inteligencje)$/.test(caption)) return "origin";
  if (/^(kto to( jest)?|kim jest (ta osoba|ten (pan|czlowiek|mezczyzna))|kto (jest )?na (tym )?(zdjeciu|obrazie|fotografii))$/.test(caption)
    || /^czy (to|to jest|na (tym )?zdjeciu (jest|widac)) (prezydent|premier)( polski| rp| polski na zdjeciu)?$/.test(caption)) return "identity";
  return undefined;
}

/** When the dialogue service is unavailable, keep photo questions tied to the attached pixels. */
export function resolveImageFocus(req: EngineRequest, decision?: ConversationDecision): ImageFocus {
  switch (decision?.kind) {
    case "image_origin": return "origin";
    case "image_copies": return "copies";
    case "image_identity": return "identity";
    case "image_context": return "context";
    case "image_visual": return "visual";
    case "verify": return "claims";
  }
  const caption = foldWords(req.text ?? "");
  if (/\b(kto to|kim jest|kto jest na|kogo widac|jaka to osoba|who is)\b/.test(caption)) return "identity";
  if (/\b(gdzie (jeszcze |wczesniej )?(opublikowano|publikowano)|znajdz (oryginal|kopie)|wyszukaj (obrazem|zdjecie)|szukaj (tego )?(obrazu|zdjecia))\b/.test(caption)) return "copies";
  if (/\b(czy to prawda|czy to prawdziwa informacja|zweryfikuj|prawdziwosc|twierdzeni\w*|wiadomosc|naglowek)\b/.test(caption)) return "claims";
  if (/\b(gdzie|kiedy|wydarzenie|zrobiono|wykonano)\b/.test(caption)) return "context";
  const subject = (req.text ?? "").replace(/^\s*czy (to( jest)?|na (tym )?zdjęciu (jest|widać))\s+/i, "");
  if (subject !== req.text && /^\p{Lu}[\p{L}’-]+(?: \p{Lu}[\p{L}’-]+){0,2}[?.!\s]*$/u.test(subject)) return "context";
  if (/^czy (prezydent|sejm|rzad|premier|minister|parlament|nato|ue)\b/.test(caption)) return "claims";
  return "visual";
}

export function shouldSearchImage(req: EngineRequest): boolean {
  const caption = foldWords(req.text ?? "");
  if (/\b(bez (google|internetu|wyszukiwania)|nie (?:wysylaj|szukaj|wyszukuj|sprawdzaj|uzywaj|korzystaj)\b.{0,65}\b(?:google|internetu|internecie|sieci|wyszukiwarki))\b/.test(caption)) return false;
  if (req.imageOptions?.searchWeb !== undefined) return req.imageOptions.searchWeb;
  return req.imageFocus === "copies" || req.imageFocus === "identity" || req.imageFocus === "context";
}
