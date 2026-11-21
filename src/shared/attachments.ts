export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_CHAT_TEXT_CHARS = 4000;
export const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export const DOCUMENT_MIMES = ["text/plain", "application/pdf"] as const;

export type ChatImage = { mime: (typeof IMAGE_MIMES)[number]; base64: string };
export type ChatDocument = { mime: (typeof DOCUMENT_MIMES)[number]; base64: string };
export type ImageOptions = { searchWeb?: boolean };
