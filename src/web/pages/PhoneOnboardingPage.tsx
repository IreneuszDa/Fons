// Copyright (c) Meta Platforms, Inc. and affiliates.
// Adapted from the Astryx login template.
import { useState, type FormEvent } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { PhoneIcon } from "@heroicons/react/24/outline";
import { ApiError, requestWhatsApp } from "../api";
import { normalizePhone } from "../../shared/phone";

/** Only the number this browser saved, so a returning visitor can ask Fons to write again in one tap. */
const PROFILE_KEY = "fons.whatsappPhone.v1";

function readSavedPhone(): string | null {
  try {
    const stored = localStorage.getItem(PROFILE_KEY);
    return stored && normalizePhone(stored) === stored ? stored : null;
  } catch {
    return null;
  }
}

function rememberPhone(phone: string | null) {
  try {
    if (phone) localStorage.setItem(PROFILE_KEY, phone);
    else localStorage.removeItem(PROFILE_KEY);
  } catch { /* Storage may be blocked; the signup itself already happened on the server. */ }
}

export default function PhoneOnboardingPage() {
  const [saved, setSaved] = useState(readSavedPhone);
  const [isEditing, setEditing] = useState(false);
  const [phone, setPhone] = useState(saved ?? "");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isSending, setSending] = useState(false);
  const showSaved = saved !== null && !isEditing;

  async function send(number: string) {
    setSending(true);
    setError("");
    setNotice("");
    try {
      const status = await requestWhatsApp(number);
      rememberPhone(number);
      setSaved(number);
      setEditing(false);
      setNotice(status === "pending"
        ? "Gotowe. Fons napisze do Ciebie na WhatsAppie. Wiadomość przyjdzie z numeru operatora Fons, czasem z kilkuminutowym opóźnieniem."
        : "Fons przed chwilą do Ciebie napisał. Sprawdź WhatsAppa; ponownie możesz poprosić za minutę.");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Nie udało się zapisać numeru. Spróbuj ponownie.");
    } finally {
      setSending(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizePhone(phone);
    if (!normalized) {
      setError("Wpisz 9 cyfr polskiego numeru albo pełny numer z kodem kraju, np. +44…");
      return;
    }
    if (!consent) {
      setError("Zaznacz zgodę, żeby Fons mógł do Ciebie napisać.");
      return;
    }
    void send(normalized);
  }

  return (
    <Center axis="both" minHeight="100dvh" padding={6}>
      <VStack gap={4} width="100%" maxWidth="23rem">
        <VStack gap={2}>
          <Heading level={2} accessibilityLevel={1} style={{ fontFamily: '"Iowan Old Style", Georgia, serif' }}>
            Fons na WhatsAppie
          </Heading>
          <Text as="p" color="secondary">
            {showSaved
              ? `Twój numer: ${saved}. Fons pisze do Ciebie na WhatsAppie, a Ty odpisujesz zdaniem, linkiem albo pytaniem.`
              : "Podaj numer, a Fons napisze do Ciebie na WhatsAppie. Odpisz zdaniem, linkiem albo pytaniem do sprawdzenia."}
          </Text>
        </VStack>
        <VStack gap={2} aria-live="polite">
          {notice && <Text as="p">{notice}</Text>}
          {error && showSaved && <Text as="p" role="alert">{error}</Text>}
        </VStack>
        {showSaved ? (
          <VStack gap={2}>
            <Button label="Niech Fons napisze do mnie" variant="primary" size="lg" isLoading={isSending}
              onClick={() => void send(saved)} />
            <Button label="Zmień numer" size="lg" onClick={() => { setEditing(true); setNotice(""); setConsent(false); }} />
            <Button label="Wróć do czatu" size="lg" href="/" />
          </VStack>
        ) : (
          <form onSubmit={submit}>
            <VStack gap={4}>
              <TextInput label="Numer telefonu" isLabelHidden type="tel" size="lg" startIcon={PhoneIcon}
                autoComplete="tel" enterKeyHint="done" hasAutoFocus={isEditing}
                placeholder="+48 500 000 000" value={phone}
                onChange={value => { setPhone(value); setError(""); }}
                status={error ? { type: "error", message: error } : undefined} />
              <CheckboxInput value={consent} onChange={checked => { setConsent(checked); setError(""); }}
                label="Zgadzam się, aby Fons napisał do mnie na WhatsAppie"
                description="Numer służy tylko do tej rozmowy. Aby usunąć dane, napisz do Fons „usuń moje dane”." />
              <VStack gap={2}>
                <Button label="Zapisz numer" type="submit" variant="primary" size="lg" isLoading={isSending} />
                {saved && <Button label="Anuluj" size="lg" onClick={() => { setEditing(false); setPhone(saved); setError(""); }} />}
                <Button label="Wróć do czatu" size="lg" href="/" />
              </VStack>
            </VStack>
          </form>
        )}
        <Text as="p" type="supporting" color="secondary">
          Każde zapisanie numeru prosi Fons o nową wiadomość. Nowe rozmowy startują partiami, najwyżej kilka na godzinę.
        </Text>
      </VStack>
    </Center>
  );
}
