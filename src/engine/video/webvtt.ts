export type SubtitleSegment = { seconds: number; text: string };

/** A literal quote may span consecutive cues. An explicit timestamp selects its occurrence. */
export function subtitleStart(cues: readonly SubtitleSegment[], quote: string, seconds?: number | null): number | undefined {
  const exact = quote.trim();
  if (!exact || seconds === null) return;
  const transcript = cues.map(cue => cue.text).join(" ");
  let match = transcript.indexOf(exact);
  let offset = 0;
  for (const cue of cues) {
    if (match < 0) return;
    const end = offset + cue.text.length;
    if (match < end && (seconds === undefined || seconds === cue.seconds)) return cue.seconds;
    offset = end + 1;
    if (match < offset) match = transcript.indexOf(exact, offset);
  }
}

function timestamp(value: string) {
  const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value);
  return match ? Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000 : NaN;
}

export function parseWebVtt(vtt: string, maxSeconds = 600): SubtitleSegment[] {
  const blocks = vtt.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n[\t ]*\n/);
  if (!/^WEBVTT(?:[\t \n]|$)/.test(blocks.shift() ?? "")) return [];
  const rows: SubtitleSegment[] = [];
  let characters = 0;
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", nbsp: " ", lrm: "", rlm: "" };
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (/^(?:NOTE(?:\s|$)|STYLE$|REGION$)/.test(lines[0] ?? "")) continue;
    const timingIndex = lines[0]?.includes("-->") ? 0 : 1;
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s|$)/.exec(lines[timingIndex] ?? "");
    if (!match) continue;
    const start = timestamp(match[1]!);
    const end = timestamp(match[2]!);
    if (!(start < end)) continue;
    if (start >= maxSeconds || end > maxSeconds + 1) return [];
    const text = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]*>/g, "")
      .replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_, key: string) => entities[key]!)
      .replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.length > 1_500) return [];
    characters += text.length;
    if (characters > 32_000 || rows.length >= 1_200) return [];
    rows.push({ seconds: start, text });
  }
  return rows.sort((a, b) => a.seconds - b.seconds);
}
