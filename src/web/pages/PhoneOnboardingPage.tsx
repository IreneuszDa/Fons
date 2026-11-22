// Copyright (c) Meta Platforms, Inc. and affiliates.
// Adapted from the Astryx login and form-wizard templates.
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon } from "@heroicons/react/24/outline";
import { isWhatsAppSignupStatus, normalizeWhatsAppPhone, type WhatsAppSignupStatus } from "../../shared/whatsapp";
import { phoneOnboardingStyles } from "./phoneOnboardingStyles";

const steps = [
  {
    title: "Sprawdź informację u źródła",
    description: "Wyślij Fonsowi na WhatsAppie zdanie, link albo pytanie. Sprawdzi dla Ciebie, co mówią źródła.",
    illustration: "check",
  },
  {
    title: "Zobacz, skąd to wiemy",
    description: "Dostaniesz krótką odpowiedź po polsku z linkami do źródeł. Jeśli zabraknie dowodów, Fons Ci o tym powie.",
    illustration: "sources",
  },
  {
    title: "Podaj numer",
    description: "Fons napisze do Ciebie na WhatsAppie.",
    illustration: "phone",
  },
] as const;

function Confetti() {
  return (
    <VStack className="phone-confetti" aria-hidden="true">
      {Array.from({ length: 32 }, (_, i) => (
        <i key={i} style={{
          left: `${(i * 37) % 100}%`,
          animationDelay: `${(i * 71) % 570}ms`,
          animationDuration: `${1500 + (i * 89) % 950}ms`,
          "--drift": `${(i * 17) % 81 - 40}cqw`,
          "--spin": `${(i % 2 ? -1 : 1) * (140 + i * 17)}deg`,
        } as CSSProperties} />
      ))}
    </VStack>
  );
}

export default function PhoneOnboardingPage() {
  const [step, setStep] = useState(0);
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState("");
  const [result, setResult] = useState<WhatsAppSignupStatus | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const phoneInput = useRef<HTMLInputElement>(null);
  const consentInput = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const previousScreen = useRef("0");
  const screen = result ?? String(step);
  const current = steps[step]!;
  const isPhoneStep = step === steps.length - 1;
  const normalized = normalizeWhatsAppPhone(phone);

  useEffect(() => {
    if (previousScreen.current !== screen) heading.current?.focus();
    previousScreen.current = screen;
  }, [screen]);
  useEffect(() => () => pending.current?.abort(), []);

  function editPhone() {
    setResult(null);
    setConsent(false);
    setAttempted(false);
    setSubmissionError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    setAttempted(true);
    setSubmissionError("");
    if (!normalized || !consent) {
      (normalized ? consentInput : phoneInput).current?.focus();
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setSubmitting(true);
    try {
      const response = await fetch("/api/signup/whatsapp", {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ phone: normalized, consent }), signal: controller.signal,
      });
      if (response.status === 429) {
        setSubmissionError("Za dużo prób w krótkim czasie. Odczekaj chwilę i spróbuj ponownie.");
        return;
      }
      if (response.status === 400 || response.status === 422) {
        setSubmissionError("Zgłoszenie zostało odrzucone. Sprawdź numer i jego kierunkowy.");
        phoneInput.current?.focus();
        return;
      }
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!isWhatsAppSignupStatus(data?.status)) throw new Error();
      setResult(data.status);
    } catch {
      if (!controller.signal.aborted) {
        setSubmissionError("Nie udało się potwierdzić zgłoszenia. Spróbuj ponownie.");
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  return (
    <VStack className="phone-onboarding" minHeight="100dvh" width="100%" hAlign="center">
      <style>{phoneOnboardingStyles}</style>
      <VStack as="header" hAlign="center" gap={1} paddingBlock={3}>
        <Text className="phone-wordmark">Fons</Text>
        <Text type="supporting" color="secondary">WhatsApp</Text>
      </VStack>
      <VStack className="phone-stage" width="100%" maxWidth="34rem" hAlign="center" vAlign="center">
        <VStack as="section" width="100%" className="phone-panel" aria-labelledby="phone-heading">
          <VStack as="figure" className="phone-plate" hAlign="center" vAlign="center">
            <img key={current.illustration} src={`/illustrations/onboarding-${current.illustration}.webp`}
              alt="" width={700} height={390} />
          </VStack>
          <VStack className="phone-content" hAlign="center" vAlign="center" gap={4}>
            {result ? (
              <HStack gap={2} vAlign="center" className="phone-done">
                <Icon icon={CheckIcon} size="sm" /><Text type="supporting">Numer przyjęty</Text>
              </HStack>
            ) : (
              <HStack gap={3} vAlign="center">
                <HStack gap={1} aria-hidden="true" className="phone-progress">
                  {steps.map((item, i) => <i key={item.title} data-filled={i <= step} />)}
                </HStack>
                <Text type="supporting" color="secondary">Krok {step + 1} z {steps.length}</Text>
              </HStack>
            )}
            <VStack hAlign="center" gap={3}>
              <Heading ref={heading} tabIndex={-1} id="phone-heading" className="phone-heading" level={1} justify="center" textWrap="balance">
                {result ? "Jesteśmy podłączeni!" : current.title}
              </Heading>
              <Text as="p" className="phone-description" color="secondary" justify="center">
                {result === "pending" ? "Poczekaj na pierwszą wiadomość od Fons na WhatsAppie. Możesz na nią odpisać pytaniem lub linkiem."
                  : result ? "Fons wysłał już powitanie. Otwórz rozmowę na WhatsAppie i odpisz pytaniem lub linkiem."
                  : current.description}
              </Text>
            </VStack>
            {result ? (
              <Button label="Zmień numer" variant="secondary" onClick={editPhone} />
            ) : isPhoneStep ? (
              <form className="phone-form" onSubmit={submit} noValidate>
                <VStack gap={3} hAlign="center">
                  <VStack gap={1.5} width="100%">
                    <TextInput ref={phoneInput} containerClassName="phone-number" type="tel" inputMode="tel" autoComplete="tel" enterKeyHint="send"
                      size="lg" label="Numer telefonu" placeholder="np. 600 123 456" value={phone} isReadOnly={submitting}
                      onChange={value => { setPhone(value); setSubmissionError(""); }}
                      status={attempted && !normalized ? { type: "error", message: "Wpisz 9 cyfr lub pełny numer z kodem kraju." } : undefined} />
                    <Text as="p" type="supporting" color="secondary" justify="center">Polski numer wpisz bez +48. Zagraniczny zacznij od + i kodu kraju.</Text>
                  </VStack>
                  <CheckboxInput className="phone-consent" ref={consentInput} value={consent} isDisabled={submitting}
                    label="Zgadzam się, aby Fons napisał do mnie na WhatsAppie."
                    onChange={checked => { setConsent(checked); setSubmissionError(""); }}
                    status={attempted && !consent ? { type: "error", message: "Zaznacz zgodę na wiadomość od Fons." } : undefined} />
                  {submissionError && <Text as="p" role="alert" justify="center">{submissionError}</Text>}
                  <VStack gap={1} hAlign="center" width="100%" maxWidth="19rem">
                    <Button label="Poproś o wiadomość" type="submit" variant="primary" size="lg" width="100%" isLoading={submitting} />
                    <Button label="Wstecz" icon={<Icon icon={ArrowLeftIcon} size="sm" />} variant="ghost"
                      isDisabled={submitting} onClick={() => { setStep(1); setSubmissionError(""); }} />
                  </VStack>
                  <details className="phone-privacy">
                    <summary>Prywatność numeru</summary>
                    <Text as="p" type="supporting" color="secondary" justify="center">Numer służy tylko do tej rozmowy. Aby usunąć dane, napisz do Fons „usuń moje dane”. Ta strona nie używa ciasteczek ani narzędzi śledzących.</Text>
                  </details>
                </VStack>
              </form>
            ) : (
              <VStack gap={1} hAlign="center" width="100%" maxWidth="19rem">
                <Button label="Dalej" variant="primary" size="lg" width="100%" endContent={<Icon icon={ArrowRightIcon} size="sm" />}
                  onClick={() => setStep(step + 1)} />
                {step > 0 && <Button label="Wstecz" icon={<Icon icon={ArrowLeftIcon} size="sm" />} variant="ghost" onClick={() => setStep(step - 1)} />}
              </VStack>
            )}
          </VStack>
          {result && <Confetti />}
        </VStack>
      </VStack>
      <VStack as="footer" hAlign="center" paddingBlock={3}>
        <Link href="/" type="supporting" color="secondary">Wróć do czatu</Link>
      </VStack>
    </VStack>
  );
}
