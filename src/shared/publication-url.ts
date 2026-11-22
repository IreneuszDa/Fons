const PUBLICATION_TRACKERS = /^(?:utm_.+|fbclid|gclid|mc_eid|mc_cid|igshid)$/i;

// Consume each complete address so hosts mentioned in its path/query are never new outlets.
const SUBMITTED_URL = /(?<![@\p{L}\p{N}._/-])(?:https?:\/\/[^\s<>"'`]+|(?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+\p{L}{2,}(?=[:/?#]|[\s,.;!?)\]}"'…]|$)(?::\d+)?(?:[/?#][^\s<>"'`]*)?)/giu;

export function submittedAddresses(text: string): URL[] {
  const addresses: URL[] = [];
  for (const match of text.slice(0, 20_000).matchAll(SUBMITTED_URL)) {
    const raw = match[0].replace(/[.,;:!?)\]}…]+$/u, "");
    const url = URL.parse(/^https?:\/\//iu.test(raw) ? raw : "https://" + raw);
    if (url) addresses.push(url);
  }
  return addresses;
}

/** A bibliographic lookup preserves path case, fragments and document-selecting parameters. */
export function publicationAddress(input: string): string | undefined {
  const url = URL.parse(input);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
  for (const key of [...url.searchParams.keys()]) {
    if (PUBLICATION_TRACKERS.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}
