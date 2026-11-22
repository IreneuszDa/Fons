// Copyright (c) Meta Platforms, Inc. and affiliates.
// Adapted from the Astryx login template.
import { useState, type FormEvent } from "react";
import { nanoid } from "nanoid";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { PhoneIcon } from "@heroicons/react/24/outline";

const PROFILE_KEY = "fons.demoPhoneProfile.v1";
interface DemoProfile {
  id: string;
  phone: string;
}

function normalizePhone(input: string): string | null {
  const compact = input.trim().replace(/[\s().-]/g, "").replace(/^00/, "+");
  const phone = /^\d{9}$/.test(compact) ? "+48" + compact : compact;
  if (phone.startsWith("+48") && !/^\+48[1-9]\d{8}$/.test(phone)) return null;
  return /^\+[1-9]\d{6,14}$/.test(phone) ? phone : null;
}

function readProfile(): DemoProfile | null {
  try {
    const stored = localStorage.getItem(PROFILE_KEY);
    if (!stored) return null;
    const profile = JSON.parse(stored);
    return typeof profile?.id === "string" && profile.id &&
      typeof profile.phone === "string" && normalizePhone(profile.phone) === profile.phone ? profile : null;
  } catch {
    return null;
  }
}

export default function PhoneOnboardingPage() {
  const [profile, setProfile] = useState(readProfile);
  const [isEditing, setEditing] = useState(false);
  const [phone, setPhone] = useState(profile?.phone ?? "");
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const saved = profile && !isEditing;

  function save(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizePhone(phone);
    if (!normalized) {
      setError("Wpisz 9 cyfr dla Polski lub pełny numer z kodem kraju.");
      return;
    }
    try {
      const next = { id: profile?.id ?? nanoid(), phone: normalized };
      localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
      setProfile(next);
      setPhone(normalized);
      setEditing(false);
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }

  return (
    <Center axis="both" minHeight="100dvh" padding={6}>
      <VStack gap={4} width="100%" maxWidth="23rem">
        <VStack gap={2} aria-live="polite">
          <Heading level={2} accessibilityLevel={1} style={{ fontFamily: '"Iowan Old Style", Georgia, serif' }}>
            {saved ? "Twój profil w Fons" : "Zaloguj się do Fons"}
          </Heading>
          <Text as="p" color="secondary">
            {saved ? `Zapisany numer telefonu: ${profile.phone}` : "Podaj numer telefonu do profilu próbnego."}
          </Text>
        </VStack>
        {saved ? (
          <VStack gap={2}>
            <Button label="Przejdź do czatu" variant="primary" size="lg" href="/" />
            <Button label="Zmień numer" size="lg" onClick={() => setEditing(true)} />
          </VStack>
        ) : (
          <form onSubmit={save}>
            <VStack gap={4}>
              <TextInput label="Numer telefonu" isLabelHidden type="tel" size="lg" startIcon={PhoneIcon}
                autoComplete="tel" enterKeyHint="done" hasAutoFocus={isEditing}
                placeholder="+48 500 000 000" value={phone}
                onChange={value => { setPhone(value); setError(""); }}
                status={error ? { type: "error", message: error } : undefined} />
              <VStack gap={2}>
                <Button label="Zapisz numer" type="submit" variant="primary" size="lg" />
                <Button label="Wróć do czatu" size="lg" href="/" />
                {storageError && <Text as="p" role="alert">Włącz lokalny zapis danych w przeglądarce i spróbuj ponownie.</Text>}
              </VStack>
            </VStack>
          </form>
        )}
        <Text as="p" type="supporting" color="secondary">
          Profil próbny jest zapisywany tylko w tej przeglądarce. Wysyłka kodów SMS jest wyłączona.
        </Text>
      </VStack>
    </Center>
  );
}
