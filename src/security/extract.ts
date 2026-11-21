/**
 * HTML → text extraction for fetched pages (linkedom + @mozilla/readability).
 *
 *  - rawText:        everything a model could be fed if we were careless, incl. hidden text,
 *                    comments, <template>, meta description/og:*, img alt/title (for the detector);
 *  - cleanText:      readable article text (Readability) with hidden elements removed and
 *                    zero-width / bidi characters stripped;
 *  - hiddenSegments: each hidden piece separately (for the detector's "hidden imperative" rule).
 */
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { stripInvisible, tidyText } from "./text";

export interface ExtractedPage {
  rawText: string;
  cleanText: string;
  title?: string;
  publishedAt?: string;
  hiddenSegments: string[];
}

const MAX_SEGMENTS = 300;
const MAX_SEGMENT_CHARS = 4000;

const BLOCK_TAGS = new Set(
  "ADDRESS ARTICLE ASIDE BLOCKQUOTE BR DD DIV DL DT FIELDSET FIGCAPTION FIGURE FOOTER FORM H1 H2 H3 H4 H5 H6 HEADER HR LI MAIN NAV OL P PRE SECTION TABLE TBODY TD TFOOT TH THEAD TR UL".split(
    " ",
  ),
);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "IFRAME", "OBJECT", "EMBED", "CANVAS", "HEAD"]);

// ─────────────────────────── CSS hiding heuristics ───────────────────────────

type Decls = Map<string, string>;

function parseDecls(style: string): Decls {
  const m: Decls = new Map();
  for (const part of style.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part
      .slice(i + 1)
      .replace(/!important/i, "")
      .trim()
      .toLowerCase();
    if (k) m.set(k, v);
  }
  return m;
}

const NAMED_COLORS: Record<string, string> = {
  white: "255,255,255",
  black: "0,0,0",
  red: "255,0,0",
  green: "0,128,0",
  blue: "0,0,255",
  yellow: "255,255,0",
  gray: "128,128,128",
  grey: "128,128,128",
  silver: "192,192,192",
  navy: "0,0,128",
  snow: "255,250,250",
  ivory: "255,255,240",
  whitesmoke: "245,245,245",
};

/** Normalises a CSS colour to "r,g,b" (or "transparent"); undefined if unknown. */
export function normColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const c = v.trim().toLowerCase();
  if (c === "transparent") return "transparent";
  if (NAMED_COLORS[c]) return NAMED_COLORS[c];
  let m = /^#([0-9a-f]{3,4})$/.exec(c);
  if (m) {
    const h = m[1]!;
    return [0, 1, 2].map((i) => parseInt(h[i]! + h[i]!, 16)).join(",");
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(c);
  if (m) {
    const h = m[1]!;
    if (m[2] === "00") return "transparent";
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(",");
  }
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(c);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return "transparent";
    return `${Number(m[1])},${Number(m[2])},${Number(m[3])}`;
  }
  return undefined;
}

function backgroundOf(d: Decls): string | undefined {
  const bg = d.get("background-color") ?? d.get("background");
  if (!bg) return undefined;
  // "background: #fff url(...)" → take first colour-looking token
  const token = bg.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b[a-z]+\b/);
  return normColor(token?.[0]);
}

function isZero(v: string | undefined): boolean {
  return v !== undefined && /^-?0*(\.0+)?(px|em|rem|pt|%|vh|vw)?$/.test(v.trim());
}

function farNegative(v: string | undefined): boolean {
  if (!v) return false;
  const m = /^(-\d+(?:\.\d+)?)(px|em|rem|pt|%|vw|vh)?$/.exec(v.trim());
  if (!m) return false;
  const n = parseFloat(m[1]!);
  const unit = m[2] ?? "px";
  return unit === "px" || unit === "pt" ? n <= -500 : n <= -50;
}

/** Why an element with these declarations is hidden, or undefined if it is visible. */
function hiddenByDecls(d: Decls, inheritedBg: string | undefined): string | undefined {
  if (d.get("display") === "none") return "display:none";
  const vis = d.get("visibility");
  if (vis === "hidden" || vis === "collapse") return "visibility:hidden";
  if (isZero(d.get("font-size"))) return "font-size:0";
  const op = d.get("opacity");
  if (op !== undefined && parseFloat(op) === 0) return "opacity:0";
  const pos = d.get("position");
  if (pos === "absolute" || pos === "fixed") {
    if (farNegative(d.get("left")) || farNegative(d.get("top")) || farNegative(d.get("right"))) return "off-screen";
  }
  if (farNegative(d.get("text-indent"))) return "off-screen";
  if (farNegative(d.get("margin-left")) || farNegative(d.get("margin-top"))) return "off-screen";
  const transform = d.get("transform");
  if (transform && /scale\(\s*0(\.0+)?\s*(,\s*0(\.0+)?\s*)?\)/.test(transform)) return "scale:0";
  const clip = d.get("clip");
  if (clip && /rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(clip)) return "clip";
  const clipPath = d.get("clip-path");
  if (clipPath && /inset\(\s*(50%|100%)/.test(clipPath)) return "clip";
  if ((isZero(d.get("height")) || isZero(d.get("max-height")) || isZero(d.get("width"))) && d.get("overflow") === "hidden")
    return "zero-size";
  const color = normColor(d.get("color"));
  if (color === "transparent") return "transparent-text";
  const bg = backgroundOf(d) ?? inheritedBg;
  if (color && bg && bg !== "transparent" && color === bg) return "same-colour";
  return undefined;
}

interface StyleRule {
  selector: string;
  decls: Decls;
}

function collectStyleRules(doc: Document): StyleRule[] {
  const rules: StyleRule[] = [];
  for (const el of Array.from(doc.querySelectorAll("style"))) {
    const css = (el.textContent ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    // Skip @media etc. bodies conservatively: only top-level "selector { decls }" pairs.
    for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      const decls = parseDecls(m[2]!);
      if (decls.size === 0) continue;
      for (const sel of m[1]!.split(",")) {
        const s = sel.trim();
        if (s && !s.includes(":")) rules.push({ selector: s, decls });
      }
    }
  }
  return rules;
}

/** Effective declarations: stylesheet rules (in order) then inline style. */
function buildStyleMap(doc: Document): Map<Element, Decls> {
  const map = new Map<Element, Decls>();
  for (const rule of collectStyleRules(doc)) {
    let els: Element[] = [];
    try {
      els = Array.from(doc.querySelectorAll(rule.selector));
    } catch {
      continue;
    }
    for (const el of els) {
      const cur = map.get(el) ?? new Map();
      for (const [k, v] of rule.decls) cur.set(k, v);
      map.set(el, cur);
    }
  }
  for (const el of Array.from(doc.querySelectorAll("[style]"))) {
    const cur = map.get(el) ?? new Map();
    for (const [k, v] of parseDecls(el.getAttribute("style") ?? "")) cur.set(k, v);
    map.set(el, cur);
  }
  return map;
}

// ─────────────────────────── text helpers ───────────────────────────

function nodeText(node: Node): string {
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      parts.push(n.textContent ?? "");
      return;
    }
    if (n.nodeType !== 1 && n.nodeType !== 11 && n.nodeType !== 9) return;
    const el = n as Element;
    const tag = n.nodeType === 1 ? el.tagName.toUpperCase() : "";
    if (SKIP_TAGS.has(tag)) return;
    const block = BLOCK_TAGS.has(tag);
    if (block) parts.push("\n");
    for (const c of Array.from(n.childNodes)) walk(c);
    if (block) parts.push("\n");
  };
  walk(node);
  return tidyText(parts.join(""));
}

function pushSegment(out: string[], s: string | null | undefined) {
  if (out.length >= MAX_SEGMENTS || !s) return;
  const t = tidyText(s);
  if (t === "") return;
  const v = t.length > MAX_SEGMENT_CHARS ? t.slice(0, MAX_SEGMENT_CHARS) : t;
  if (!out.includes(v)) out.push(v);
}

function looksLikeUrl(s: string): boolean {
  return /^(https?:)?\/\/\S+$/i.test(s.trim()) || /^\S+\.(png|jpe?g|gif|webp|svg)(\?\S*)?$/i.test(s.trim());
}

// ─────────────────────────── metadata ───────────────────────────

function normaliseDate(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (!s) return undefined;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    // date-only values stay date-only
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date(t).toISOString();
  }
  return undefined;
}

function findJsonLdDate(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const v of value) {
      const d = findJsonLdDate(v, depth + 1);
      if (d) return d;
    }
    return undefined;
  }
  const o = value as Record<string, unknown>;
  if (typeof o.datePublished === "string") return o.datePublished;
  for (const k of ["@graph", "mainEntity", "mainEntityOfPage", "itemReviewed", "subjectOf"]) {
    const d = findJsonLdDate(o[k], depth + 1);
    if (d) return d;
  }
  return undefined;
}

function extractPublishedAt(doc: Document): string | undefined {
  const metaSel = [
    'meta[property="article:published_time"]',
    'meta[name="article:published_time"]',
    'meta[itemprop="datePublished"]',
    'meta[property="og:published_time"]',
    'meta[name="pubdate"]',
    'meta[name="publishdate"]',
    'meta[name="date"]',
    'meta[name="dc.date"]',
    'meta[name="DC.date.issued"]',
  ];
  for (const sel of metaSel) {
    const d = normaliseDate(doc.querySelector(sel)?.getAttribute("content"));
    if (d) return d;
  }
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const d = normaliseDate(findJsonLdDate(JSON.parse(s.textContent ?? "")));
      if (d) return d;
    } catch {
      /* malformed JSON-LD is common; ignore */
    }
  }
  const timeEl = doc.querySelector("time[datetime]");
  return normaliseDate(timeEl?.getAttribute("datetime"));
}

// ─────────────────────────── main ───────────────────────────

/** Extracts text, hidden segments and metadata from an HTML document. */
export function extractFromHtml(html: string, url?: string): ExtractedPage {
  const { document: doc } = parseHTML(html);
  const hiddenSegments: string[] = [];

  const title = tidyText(stripInvisible(doc.querySelector("title")?.textContent ?? "")) ||
    doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
    undefined;
  const publishedAt = extractPublishedAt(doc);

  // Meta description / og:* / twitter:* (not shown on the page, but read by crawlers and models).
  for (const m of Array.from(doc.querySelectorAll("meta[content]"))) {
    const key = (m.getAttribute("name") ?? m.getAttribute("property") ?? "").toLowerCase();
    const content = m.getAttribute("content") ?? "";
    if (key === "description" || key === "keywords" || key.startsWith("og:") || key.startsWith("twitter:")) {
      if (/(image|url|type|locale|site_name|card|width|height|site|creator)$/.test(key) || looksLikeUrl(content)) continue;
      pushSegment(hiddenSegments, content);
    }
  }

  // HTML comments.
  const commentWalker = doc.createTreeWalker(doc, 128 /* NodeFilter.SHOW_COMMENT */);
  for (let n = commentWalker.nextNode(); n; n = commentWalker.nextNode()) pushSegment(hiddenSegments, n.textContent);

  // img alt / title attributes, and title attributes in general.
  for (const el of Array.from(doc.querySelectorAll("[alt], [title]"))) {
    pushSegment(hiddenSegments, el.getAttribute("alt"));
    pushSegment(hiddenSegments, el.getAttribute("title"));
  }

  const body = doc.body ?? doc.documentElement;

  // rawText: all text nodes including hidden ones (scripts/styles excluded), plus non-DOM-text segments.
  const rawDomText = body ? nodeText(body) : "";

  // Hidden elements: collect their text and remove them from the clean copy.
  const styleMap = buildStyleMap(doc);
  const toRemove: Element[] = [];
  const visit = (el: Element, inheritedBg: string | undefined) => {
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    const decls = styleMap.get(el);
    const ownBg = decls ? backgroundOf(decls) : undefined;
    const bg = ownBg && ownBg !== "transparent" ? ownBg : inheritedBg;
    let reason: string | undefined;
    if (tag === "TEMPLATE") reason = "template";
    else if (el.hasAttribute("hidden")) reason = "hidden";
    else if ((el.getAttribute("aria-hidden") ?? "").toLowerCase() === "true") reason = "aria-hidden";
    else if (tag === "INPUT" && (el.getAttribute("type") ?? "").toLowerCase() === "hidden") reason = "input-hidden";
    else if (decls) reason = hiddenByDecls(decls, inheritedBg);
    if (reason) {
      if (tag === "INPUT") pushSegment(hiddenSegments, el.getAttribute("value"));
      else if (tag === "TEMPLATE") {
        const { document: frag } = parseHTML(`<!doctype html><html><body>${el.innerHTML}</body></html>`);
        pushSegment(hiddenSegments, frag.body ? nodeText(frag.body) : el.textContent);
      } else pushSegment(hiddenSegments, nodeText(el));
      toRemove.push(el);
      return;
    }
    for (const c of Array.from(el.children)) visit(c, bg);
  };
  if (body) visit(body, undefined);
  for (const el of toRemove) el.remove();

  // Template contents may live outside the DOM tree in some parsers — include for rawText.
  const rawParts = [rawDomText];
  for (const seg of hiddenSegments) if (!rawDomText.includes(seg)) rawParts.push(seg);
  const rawText = tidyText(rawParts.join("\n"));

  // Clean text: Readability on the cleaned DOM, falling back to the cleaned body text.
  let cleanText = "";
  try {
    const clone = doc.cloneNode(true) as Document;
    const article = new Readability(clone, { charThreshold: 200 }).parse();
    if (article?.content) {
      const { document: art } = parseHTML(`<!doctype html><html><body>${article.content}</body></html>`);
      cleanText = art.body ? nodeText(art.body) : "";
    }
  } catch {
    cleanText = "";
  }
  const fallback = body ? nodeText(body) : "";
  if (cleanText.length < 200 && fallback.length > cleanText.length) cleanText = fallback;
  cleanText = tidyText(stripInvisible(cleanText));

  void url;
  return {
    rawText,
    cleanText,
    ...(title ? { title } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    hiddenSegments,
  };
}

/** Plain-text documents: no hidden markup; clean text only loses invisible characters. */
export function extractFromPlainText(text: string): ExtractedPage {
  return { rawText: text, cleanText: tidyText(stripInvisible(text)), hiddenSegments: [] };
}
