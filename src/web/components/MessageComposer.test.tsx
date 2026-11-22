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
  vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
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

async function openGuide(label: string) {
  const trigger = button("Dodaj plik");
  // LinkeDOM has no layout engine; Astryx checks the anchor's client rectangles.
  Object.defineProperty(trigger, "getClientRects", { configurable: true, value: () => [] });
  await act(async () => trigger.click());
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find(element => element.textContent?.trim() === label);
  expect(item, label).toBeDefined();
  await act(async () => item!.click());
  const panel = document.querySelector<HTMLElement>("section[aria-labelledby]")!;
  expect(panel).toBeTruthy();
  expect(document.getElementById(panel.getAttribute("aria-labelledby")!)?.textContent).toBe(label);
  return panel;
}

async function choose(files: File[]) {
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(picker, "files", { configurable: true, value: files });
  await act(async () => { picker.dispatchEvent(new window.Event("change", { bubbles: true })); });
}

async function drop(panel: HTMLElement, files: File[]) {
  const event = new window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } });
  await act(async () => { panel.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true);
}

it.each([
  ["Dokument lub zdjęcie", "Wybierz plik"],
  ["Porównaj dwa obrazy", "Wybierz obrazy"],
  ["Film", "Wybierz film"],
  ["Plik audio", "Wybierz nagranie"],
])(
  "explains %s before opening the file picker",
  async (label, chooseLabel) => {
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const openPicker = vi.spyOn(picker, "click");
    const panel = await openGuide(label);
    expect(panel.querySelector("img")?.getAttribute("src")).toBeTruthy();
    expect(document.getElementById(panel.getAttribute("aria-describedby")!)?.textContent).toBeTruthy();
    expect(openPicker).not.toHaveBeenCalled();
    await click(chooseLabel);
    expect(openPicker).toHaveBeenCalledOnce();
    await click("Zamknij podpowiedź");
    expect(panel.isConnected).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  },
);

it("keeps the draft and guide after dropping a wrong file and preserves the draft on close", async () => {
  const original = new File(["treść"], "fragment.txt", { type: "text/plain" });
  await choose([original]);
  const panel = await openGuide("Film");
  await drop(panel, [new File(["dźwięk"], "audio.mp3", { type: "audio/mpeg" })]);
  expect(document.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  expect(panel.isConnected).toBe(true);
  await click("Zamknij podpowiedź");
  await click("Wyślij");
  expect(onSubmit).toHaveBeenCalledWith({ document: {
    mime: "text/plain", base64: Buffer.from("treść").toString("base64"),
  } }, "fragment.txt");
});

it.each([true, false])("accepts a complete pair of images, selected together: %s", async together => {
  const first = new File(["pierwszy"], "pierwszy.png", { type: "image/png" });
  const second = new File(["drugi"], "drugi.jpg", { type: "image/jpeg" });
  const panel = await openGuide("Porównaj dwa obrazy");
  if (together) await drop(panel, [first, second]);
  else {
    await drop(panel, [first]);
    expect(button("Wyślij").getAttribute("aria-disabled")).toBe("true");
    await click("Wyślij");
    expect(onSubmit).not.toHaveBeenCalled();
    await click("Wybierz drugi obraz");
    await choose([second]);
  }
  expect(panel.isConnected).toBe(false);
  await click("Wyślij");
  expect(onSubmit).toHaveBeenCalledWith({
    image: { mime: "image/png", base64: Buffer.from("pierwszy").toString("base64") },
    comparisonImage: { mime: "image/jpeg", base64: Buffer.from("drugi").toString("base64") },
  }, "pierwszy.png · drugi.jpg");
});

it("allows attaching two images and removing either one before the local comparison", async () => {
  const first = new File([sample], "pierwszy.png", { type: "image/png" });
  const second = new File(["drugi"], "drugi.jpg", { type: "image/jpeg" });
  await choose([first]);
  await click("Dodaj drugi obraz do porównania");
  await click("Wybierz drugi obraz");
  await choose([second]);
  expect(document.body.textContent).toContain("porówna oba obrazy lokalnie");
  await click("Usuń obraz 1");
  expect(document.body.textContent).not.toContain("pierwszy.png");
  await click("Dodaj drugi obraz do porównania");
  await click("Wybierz drugi obraz");
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
