import { AUDIO_MIMES, DOCUMENT_MIMES, IMAGE_MIMES, MAX_ATTACHMENT_BYTES, MAX_RECORDING_BYTES, RECORDING_MIMES, VIDEO_MIMES, type ChatDocument, type ChatImage, type ChatRecording } from "../../shared/attachments";

export type DraftAttachment = { name: string } & (
  | { kind: "image"; content: ChatImage }
  | { kind: "document"; content: ChatDocument }
  | { kind: "recording"; content: ChatRecording }
);

export const DOCUMENT_ACCEPT = [...IMAGE_MIMES, ...DOCUMENT_MIMES, ".txt", ".pdf", ".jpg", ".jpeg", ".png", ".webp"].join(",");
export const AUDIO_ACCEPT = [...AUDIO_MIMES, ".wav", ".mp3", ".m4a", ".ogg", ".opus", ".weba"].join(",");
export const VIDEO_ACCEPT = [...VIDEO_MIMES, ".mp4", ".mov", ".webm"].join(",");
export const FILE_ACCEPT = [DOCUMENT_ACCEPT, AUDIO_ACCEPT, VIDEO_ACCEPT].join(",");

export function imagePreviewSrc(image: ChatImage): string {
  return `data:${image.mime};base64,${image.base64}`;
}

const extensionMime: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf", txt: "text/plain",
  wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg", weba: "audio/webm",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

export async function prepareAttachment(file: File): Promise<DraftAttachment> {
  if (!file.size) throw new Error("Wybrany plik jest pusty.");
  // Some OS file pickers omit MIME; the API also validates the decoded bytes.
  const type = file.type.split(";")[0]?.trim().toLowerCase();
  const aliases: Record<string, string> = { "audio/x-wav": "audio/wav", "audio/x-m4a": "audio/mp4", "audio/vnd.wave": "audio/wav", "audio/opus": "audio/ogg", "application/ogg": "audio/ogg" };
  const mime = type && type !== "application/octet-stream" ? aliases[type] ?? type : extensionMime[file.name.split(".").pop()?.toLowerCase() ?? ""];
  const image = IMAGE_MIMES.find(item => item === mime);
  const document = DOCUMENT_MIMES.find(item => item === mime);
  const recording = RECORDING_MIMES.find(item => item === mime);
  if (!image && !document && !recording) throw new Error("Obsługiwane pliki to PDF, TXT, JPG, PNG, WebP, MP4, MOV, WebM, MP3, M4A, WAV i OGG.");
  const limit = recording ? MAX_RECORDING_BYTES : MAX_ATTACHMENT_BYTES;
  if (file.size > limit) throw new Error(`Ten plik jest za duży. Wybierz plik do ${limit / 1024 ** 2} MB.`);

  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.onerror = reader.onabort = () => reject(new Error("Nie udało się odczytać pliku. Wybierz go ponownie."));
    reader.readAsDataURL(file);
  });
  if (recording) return { name: file.name, kind: "recording", content: { mime: recording, base64 } };
  return image
    ? { name: file.name, kind: "image", content: { mime: image, base64 } }
    : { name: file.name, kind: "document", content: { mime: document!, base64 } };
}
