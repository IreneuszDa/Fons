export interface ArchiveMaterial {
  recordId: string;
  title: string;
  excerpt: string;
  url: string;
  publisher: string;
  publishedAt: string | null;
  fetchedAt: string;
  termsUrl: string;
  /** Catalog terms recorded at save time. Older snapshots predate this field. */
  licence?: string;
  attribution: string;
  sha256: string;
}

export interface SavedMaterial extends ArchiveMaterial {
  id: string;
  savedAt: string;
  expiresAt: string;
}
