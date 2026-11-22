import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import plPL from "@astryxdesign/core/locales/pl-PL.generated.js";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageComposer } from "./MessageComposer";

let root: Root;
const stopTrack = vi.fn();
const getUserMedia = vi.fn();
const onSubmit = vi.fn();
const sample = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);

class TestRecorder {
  static isTypeSupported(mime: string) { return mime === "audio/webm;codecs=opus"; }
  state = "inactive";
  ondataavailable?: (event: {data: Blob}) => void;
  onstop?: () => void;
  constructor(readonly stream: MediaStream) {}
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([sample]) });
    this.onstop?.();
  }
}

beforeEach(async () => {
  const { window } = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("getSelection", () => null);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => setTimeout(() => frame(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.stubGlobal("MediaRecorder", TestRecorder);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("FileReader", class {
    result?: string;
    onload?: () => void;
    async readAsDataURL(file: File) {
      const bytes = Buffer.from(await file.arrayBuffer());
      this.result = `data:${file.type};base64,${bytes.toString("base64")}`;
      this.onload?.();
    }
  });
  getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  root = createRoot(document.querySelector("main")!);
  await act(async () => root.render(
    <InternationalizationProvider locale="pl-PL" messages={{ "pl-PL": plPL }}>
      <MessageComposer onSubmit={onSubmit} />
    </InternationalizationProvider>,
  ));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function button(label: string): HTMLButtonElement {
  const element = Array.from(document.querySelectorAll("button")).find(b =>
    b.getAttribute("aria-label") === label || b.textContent?.trim() === label);
  expect(element, label).toBeDefined();
  return element!;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

it("opens the microphone directly and prepares an audio attachment until the user sends it", async () => {
  expect(getUserMedia).not.toHaveBeenCalled();
  await click("Nagraj notatkę głosową");
  expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
  expect(document.body.textContent).toContain("Nagrywanie");
  await click("Zakończ");
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Notatka głosowa.weba");
  expect(onSubmit).not.toHaveBeenCalled();
  await click("Wyślij");
  expect(onSubmit).toHaveBeenCalledWith({
    recording: { mime: "audio/webm", base64: Buffer.from(sample).toString("base64") },
  }, "Notatka głosowa.weba");
});

it("can remove a recorded draft without sending it", async () => {
  await click("Nagraj notatkę głosową");
  await click("Zakończ");
  await click("Usuń załącznik");
  expect(document.body.textContent).not.toContain("Notatka głosowa.weba");
  await click("Wyślij");
  expect(onSubmit).not.toHaveBeenCalled();
});

it("discards a cancelled recording and explains microphone access denial", async () => {
  await click("Nagraj notatkę głosową");
  await click("Anuluj");
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(document.body.textContent).not.toContain("Notatka głosowa.weba");
  getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
  await click("Nagraj notatkę głosową");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Brak dostępu do mikrofonu");
  expect(onSubmit).not.toHaveBeenCalled();
});
