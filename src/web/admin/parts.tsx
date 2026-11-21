import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Heading, Text } from "@astryxdesign/core/Text";
import { LockClosedIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import type { LoadError } from "./useAdminData";

export const FORBIDDEN_TITLE_PL = "Brak uprawnień";

export function Forbidden({ message }: { message?: string }) {
  return (
    <EmptyState
      headingLevel={2}
      icon={<Icon icon={LockClosedIcon} size="lg" />}
      title={FORBIDDEN_TITLE_PL}
      description={message || "Twoja rola nie ma dostępu do tej części panelu. Jeśli to pomyłka, poproś administratora o zmianę roli."}
    />
  );
}

/** Loading / forbidden / error states shared by every panel tab. Renders children only when data is ready. */
export function PanelState({
  isLoading,
  error,
  onRetry,
  hasData,
  loadingLabel = "Wczytuję dane…",
  children,
}: {
  isLoading: boolean;
  error: LoadError | null;
  onRetry: () => void;
  hasData: boolean;
  loadingLabel?: string;
  children: ReactNode;
}) {
  if (error?.kind === "forbidden") return <Forbidden message={error.message} />;
  return (
    <VStack gap={4}>
      {error ? (
        <Banner
          status="error"
          title="Nie udało się wczytać danych"
          description={error.message}
          collapsible={false}
          endContent={<Button label="Spróbuj ponownie" variant="secondary" size="sm" onClick={onRetry} />}
        />
      ) : null}
      {isLoading && !hasData ? <Spinner size="lg" label={loadingLabel} aria-label={loadingLabel} /> : null}
      {hasData ? children : null}
    </VStack>
  );
}

/** One headline number (dashboard template's metric card, without sparkline). */
export function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card padding={4}>
      <VStack gap={1}>
        <Text type="supporting" color="secondary">
          {label}
        </Text>
        <Heading level={2} accessibilityLevel={3}>
          {value}
        </Heading>
        {hint ? (
          <Text type="supporting" color="secondary">
            {hint}
          </Text>
        ) : null}
      </VStack>
    </Card>
  );
}

export function SectionHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <HStack gap={3} wrap="wrap" vAlign="center" hAlign="between">
      <Heading level={3} accessibilityLevel={2}>
        {title}
      </Heading>
      {actions}
    </HStack>
  );
}

/** Confirmation for destructive actions (revoke token, remove user, clear cache). */
export function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel,
  isBusy,
  onConfirm,
  onCancel,
}: {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  isBusy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => !open && onCancel()} width={440} padding={6}>
      <VStack gap={4}>
        <DialogHeader title={title} onOpenChange={(open) => !open && onCancel()} hasDivider={false} />
        <Text as="p">{description}</Text>
        <HStack gap={2} hAlign="end" wrap="wrap">
          <Button label="Anuluj" variant="secondary" onClick={onCancel} />
          <Button label={confirmLabel} variant="destructive" isLoading={isBusy} onClick={onConfirm} />
        </HStack>
      </VStack>
    </Dialog>
  );
}

/** Saves a Blob through a temporary object URL (no persistent state). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
