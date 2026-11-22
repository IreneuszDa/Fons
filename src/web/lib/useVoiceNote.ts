import { useEffect, useRef, useState } from "react";
import { MAX_RECORDING_BYTES, MAX_RECORDING_SECONDS } from "../../shared/attachments";

import { transcribeDictation } from "../api";
import { prepareAttachment } from "./attachment";
export function useVoiceNote(onText: (text: string) => void, onError: (message: string) => void) {
  const [state, setState] = useState<"idle" | "requesting" | "recording" | "transcribing">("idle");
  const attempt = useRef(0);
  const transcription = useRef<AbortController | null>(null);
  const capture = useRef<MediaRecorder | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const release = () => {
    transcription.current?.abort();
    transcription.current = null;
    clearTimeout(deadline.current);
    const recorder = capture.current;
    capture.current = null;
    if (!recorder) return;
    if (recorder.state !== "inactive") recorder.stop();
    for (const track of recorder.stream.getTracks()) track.stop();
  };
  const cancel = () => {
    attempt.current++;
    release();
    setState("idle");
  };
  useEffect(() => () => { attempt.current++; release(); }, []);

  const available = typeof MediaRecorder !== "undefined" && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  async function start() {
    if (!available) {
      onError("Nagrywanie jest niedostępne w tej przeglądarce. Możesz dołączyć plik audio przyciskiem plus.");
      return;
    }
    if (capture.current || state !== "idle") return;
    const token = ++attempt.current;
    setState("requesting");
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (token !== attempt.current) { stream.getTracks().forEach(track => track.stop()); return; }
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error("unsupported");
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
      capture.current = recorder;
      const chunks: Blob[] = [];
      let size = 0;
      recorder.ondataavailable = event => {
        if (token !== attempt.current) return;
        size += event.data.size;
        if (size > MAX_RECORDING_BYTES) { cancel(); onError("Nagranie przekracza 20 MB. Nagraj krótszy fragment."); }
        else chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (token !== attempt.current) return;
        cancel();
        onError("Nagrywanie zostało przerwane. Możesz dołączyć gotowy plik audio.");
      };
      recorder.onstop = async () => {
        if (token !== attempt.current) return;
        release();
        setState("transcribing");
        const controller = new AbortController();
        transcription.current = controller;
        const type = mimeType.split(";")[0]!;
        const extension = type === "audio/mp4" ? "m4a" : type === "audio/ogg" ? "ogg" : "weba";
        try {
          const audio = await prepareAttachment(new File(chunks, `audio.${extension}`, { type }));
          if (audio.kind !== "recording" || token !== attempt.current) return;
          const text = await transcribeDictation(audio.content, controller.signal);
          if (token === attempt.current) onText(text);
        } catch (error) {
          if (token === attempt.current) onError(error instanceof Error ? error.message : "Nie udało się przepisać nagrania.");
        } finally {
          if (token === attempt.current) { transcription.current = null; setState("idle"); }
        }
      };
      recorder.start(1000);
      deadline.current = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, MAX_RECORDING_SECONDS * 1000);
      setState("recording");
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      if (token !== attempt.current) return;
      cancel();
      onError(error instanceof Error && error.name === "NotAllowedError"
        ? "Brak dostępu do mikrofonu. Możesz dołączyć gotowy plik audio."
        : "Nie udało się uruchomić mikrofonu. Możesz dołączyć gotowy plik audio.");
    }
  }
  function stop() { if (capture.current?.state === "recording") capture.current.stop(); }
  return { state, available, start, stop, cancel };
}
