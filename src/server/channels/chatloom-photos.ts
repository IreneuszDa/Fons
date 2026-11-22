import type { MediaItem } from "../context";
import { localConversationKind } from "../conversation/agent";
import { linksIn } from "../conversation/history";
import { foldWords } from "../util";

const PHOTO_TTL_MS = 5 * 60_000;
const QUESTION_WAIT_MS = 12_000;
const NEARBY_PHOTO_MS = 45_000;
const MAX_PHOTOS = 16;
const MAX_WAITING_QUESTIONS = 64;

interface Photo {
  session: string;
  sender: string;
  sentAt: number;
  image: MediaItem;
}

interface Question {
  session: string;
  sender: string;
  sentAt: number;
  text: string;
  replyTo?: string;
}

function reference(text: string) {
  const words = foldWords(text);
  const explicit = /\b(?:zdjeci\w*|fotografi\w*|fotk\w*|obraz(?:u|ie|ek|ka|ku|em)?|grafik\w*|screensho\w*|zrzut\w*|photo|picture|image|screenshot)\b/.test(words);
  const contextual = /\b(?:tutaj|tu|tam|tego|na nim|na niej|na tym|co to|kto to|czy to|skad to|sprawdz to|widac)\b/.test(words);
  const dialogue = localConversationKind(text);
  const question = !dialogue && (text.includes("?") || /^(?:czy|co|kto|czemu|kiedy|gdzie|skad|jak\w*|ile|kt\w*|what|who|when|where|how|is)\b/.test(words));
  return { explicit, contextual, question };
}

/** The operator can upload a photo while a preceding text or voice question is still open. */
export function chatLoomPhotos(now: () => number) {
  const photos = new Map<string, Photo & { expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
  const waiting = new Map<string, { sender: string; accept: (photo?: Photo, key?: string) => boolean }>();

  function remove(key: string) {
    const photo = photos.get(key);
    if (photo) clearTimeout(photo.timer);
    photos.delete(key);
  }

  return {
    add(key: string, photo: Photo): boolean {
      const receivedAt = now();
      const expiresAt = Math.min(photo.sentAt, receivedAt) + PHOTO_TTL_MS;
      if (expiresAt <= receivedAt) return false;
      remove(key);
      if (photos.size >= MAX_PHOTOS) remove(photos.keys().next().value!);
      const timer = setTimeout(() => remove(key), expiresAt - receivedAt);
      timer.unref();
      photos.set(key, { ...photo, expiresAt, timer });
      return waiting.get(photo.session)?.accept(photo, key) ?? false;
    },
    remove,
    forget(sender: string) {
      for (const [key, photo] of photos) {
        if (photo.sender === sender) remove(key);
      }
      for (const question of waiting.values()) {
        if (question.sender === sender) question.accept();
      }
    },
    async forQuestion(q: Question, wait: boolean): Promise<MediaItem | undefined> {
      const { explicit, contextual, question } = reference(q.text);
      const implicit = (explicit || contextual || question) && !linksIn(q.text).length;
      if (!q.replyTo && !implicit) return;
      const matches = (photo: Photo, key: string) => {
        if (photo.session !== q.session) return false;
        if (q.replyTo) return q.replyTo === key;
        const elapsed = q.sentAt - photo.sentAt;
        return elapsed >= -QUESTION_WAIT_MS && elapsed <= (explicit || contextual ? PHOTO_TTL_MS : NEARBY_PHOTO_MS);
      };

      let latest: Photo | undefined;
      for (const [key, photo] of photos) {
        if (photo.expiresAt > now() && matches(photo, key) && (!latest || photo.sentAt >= latest.sentAt)) latest = photo;
      }
      if (latest) return latest.image;
      if (!wait || waiting.has(q.session) || waiting.size >= MAX_WAITING_QUESTIONS) return;

      return new Promise(resolve => {
        const finish = (image?: MediaItem) => {
          clearTimeout(timer);
          waiting.delete(q.session);
          resolve(image);
        };
        const timer = setTimeout(finish, QUESTION_WAIT_MS);
        waiting.set(q.session, { sender: q.sender, accept: (photo, key) => {
          if (photo && !matches(photo, key!)) return false;
          finish(photo?.image);
          return true;
        } });
      });
    },
  };
}
