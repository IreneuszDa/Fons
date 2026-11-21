import { execFile } from "node:child_process";
import { MAX_TEXT_CHARS } from "../../engine/normalize";
import type { MediaItem } from "../context";

export async function readDocument(file: MediaItem): Promise<string> {
  const bytes = Buffer.from(file.base64, "base64");
  let text: string;
  if (file.mime === "application/pdf") {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Plik nie ma poprawnego nagłówka PDF.");
    text = await new Promise<string>((resolve, reject) => {
      const proc = execFile("pdftotext", ["-enc", "UTF-8", "-", "-"], {
        timeout: 5000, killSignal: "SIGKILL", maxBuffer: 512 * 1024, encoding: "utf8",
      }, (err, stdout) => {
        if (!err) return resolve(stdout);
        const message = err.code === "ENOENT" ? "Odczyt PDF jest teraz niedostępny. Możesz wysłać plik TXT."
          : "Nie udało się odczytać PDF. Wyślij wybrane strony jako zdjęcie lub wklej tekst.";
        reject(new Error(message));
      });
      proc.stdin?.on("error", () => {}); // The child can reject the file before consuming all input.
      proc.stdin?.end(bytes);
    });
  } else if (file.mime === "text/plain") {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Zapisz plik TXT w kodowaniu UTF-8 i wyślij go ponownie.");
    }
    if (/[\u0000-\u0008\u000e-\u001f]/u.test(text)) throw new Error("Ten plik zawiera dane binarne. Wyślij tekst w formacie TXT.");
  } else {
    throw new Error("Dokument musi być plikiem TXT lub PDF.");
  }
  text = text.replace(/\f/g, "\n").trim();
  if (!text) throw new Error("Nie znalazłem tekstu w pliku. Jeśli to skan, prześlij zdjęcie strony.");
  if (text.length > MAX_TEXT_CHARS) throw new Error("Tekst dokumentu przekracza 20 000 znaków. Prześlij wybrane strony lub krótszy fragment.");
  return text;
}
