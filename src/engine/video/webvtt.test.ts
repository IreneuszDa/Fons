import { describe, expect, it } from "vitest";
import { parseWebVtt } from "./webvtt";

const timing = "00:00:01.000 --> 00:00:02.000";
const cue = (text: string) => `${timing}\n${text}`;
const track = (...blocks: string[]) => ["WEBVTT", ...blocks].join("\n\n");

describe("complete public subtitle tracks", () => {
  it.each([
    ["one overlong cue", [cue("a".repeat(1501))]],
    ["total text length", Array.from({ length: 22 }, () => cue("a".repeat(1500)))],
    ["total number of cues", Array.from({ length: 1200 }, () => cue("a"))],
    ["time limit", ["00:09:59.000 --> 00:10:01.001\nend"]],
  ] as const)("discards the entire track on exceeding the %s budget", (_, blocks) => {
    expect(parseWebVtt(track(cue("start"), ...blocks))).toEqual([]);
  });
  it("allows a final cue to end within one second of the reported duration", () => {
    expect(parseWebVtt(track("00:09:59.500 --> 00:10:01.000\nend"))).toEqual([{ seconds: 599.5, text: "end" }]);
  });
});
