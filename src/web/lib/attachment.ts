import { DOCUMENT_MIMES, IMAGE_MIMES, MAX_ATTACHMENT_BYTES, type ChatDocument, type ChatImage } from "../../shared/attachments";

export type DraftAttachment = { name: string } & (
  | { kind: "image"; content: ChatImage }
  | { kind: "document"; content: ChatDocument }
);

export const FILE_ACCEPT = [...IMAGE_MIMES, ...DOCUMENT_MIMES, ".txt", ".pdf", ".jpg", ".jpeg", ".png", ".webp"].join(",");
export const FILE_HINT = "JPG, PNG, WebP, PDF lub TXT, do 5 MB";

export function imagePreviewSrc(image: ChatImage): string {
  return `data:${image.mime};base64,${image.base64}`;
}

const extensionMime: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf", txt: "text/plain",
};

export async function prepareAttachment(file: File): Promise<DraftAttachment> {
  if (!file.size) throw new Error("Wybrany plik jest pusty.");
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("Ten plik jest za duży. Wybierz plik do 5 MB.");
  // Some OS file pickers omit MIME; the API also validates the decoded bytes.
  const mime = file.type || extensionMime[file.name.split(".").pop()?.toLowerCase() ?? ""];
  const image = IMAGE_MIMES.find(item => item === mime);
  const document = DOCUMENT_MIMES.find(item => item === mime);
  if (!image && !document) throw new Error("Wybierz obraz JPG, PNG lub WebP, dokument PDF albo plik TXT.");

  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.onerror = reader.onabort = () => reject(new Error("Nie udało się odczytać pliku. Wybierz go ponownie."));
    reader.readAsDataURL(file);
  });
  return image
    ? { name: file.name, kind: "image", content: { mime: image, base64 } }
    : { name: file.name, kind: "document", content: { mime: document!, base64 } };
}
