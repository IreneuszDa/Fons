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
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ text: "Sprawdź tę informację." })));
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("Node", window.Node);
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

it("allows attaching two images and removing either one before the local comparison", async () => {
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  async function choose(files: File[]) {
    Object.defineProperty(picker, "files", { configurable: true, value: files });
    await act(async () => { picker.dispatchEvent(new window.Event("change", { bubbles: true })); });
  }
  const first = new File([sample], "pierwszy.png", { type: "image/png" });
  const second = new File(["drugi"], "drugi.jpg", { type: "image/jpeg" });
  await choose([first]);
  await click("Dodaj drugi obraz do porównania");
  await choose([second]);
  expect(document.body.textContent).toContain("porówna oba obrazy lokalnie");
  await click("Usuń obraz 1");
  expect(document.body.textContent).not.toContain("pierwszy.png");
  await click("Dodaj drugi obraz do porównania");
  await choose([first]);
  await click("Wyślij");
  expect(onSubmit).toHaveBeenCalledWith({
    image: { mime: "image/jpeg", base64: Buffer.from("drugi").toString("base64") },
    comparisonImage: { mime: "image/png", base64: Buffer.from(sample).toString("base64") },
  }, "drugi.jpg · pierwszy.png");
});

it("transcribes dictation into the editable draft and sends only text", async () => {
  expect(getUserMedia).not.toHaveBeenCalled();
  await click("Dyktuj wiadomość");
  expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
  expect(document.body.textContent).toContain("Nagrywanie");
  await click("Zakończ");
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Sprawdź tę informację.");
  expect(onSubmit).not.toHaveBeenCalled();
  await click("Wyślij");
  expect(onSubmit).toHaveBeenCalledWith({
    text: "Sprawdź tę informację.",
  }, undefined);
});

it("keeps a failed transcription out of the conversation", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ messagePl: "Nie rozpoznano mowy." }, { status: 422 }));
  await click("Dyktuj wiadomość");
  await click("Zakończ");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Nie rozpoznano mowy.");
  expect(onSubmit).not.toHaveBeenCalled();
});

it("discards a cancelled recording and explains microphone access denial", async () => {
  await click("Dyktuj wiadomość");
  await click("Anuluj");
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(document.body.textContent).not.toContain("Notatka głosowa.weba");
  getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
  await click("Dyktuj wiadomość");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Brak dostępu do mikrofonu");
  expect(onSubmit).not.toHaveBeenCalled();
});
