import { useEffect, useRef, useState } from "react";
import { MAX_RECORDING_BYTES, MAX_RECORDING_SECONDS } from "../../shared/attachments";

/** A click opens the microphone. Stopping creates a draft attachment for the user to send. */
export function useVoiceNote(onFile: (file: File) => void, onError: (message: string) => void) {
  const [state, setState] = useState<"idle" | "requesting" | "recording">("idle");
  const attempt = useRef(0);
  const capture = useRef<MediaRecorder | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const release = () => {
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
      recorder.onstop = () => {
        if (token !== attempt.current) return;
        release();
        setState("idle");
        const type = mimeType.split(";")[0]!;
        const extension = type === "audio/mp4" ? "m4a" : type === "audio/ogg" ? "ogg" : "weba";
        onFile(new File(chunks, `Notatka głosowa.${extension}`, { type }));
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
