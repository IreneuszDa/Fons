import { useState } from "react";

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { pixel, proportional, Table, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Token } from "@astryxdesign/core/Token";
import { formatDateTime } from "../lib/format";
import { CASE_STATUSES, fetchCases, patchCase, type AdminCase, type CasePatch, type CaseStatus } from "./adminApi";
import { PanelState, SectionHeader } from "./parts";
import { ALERT_STATE_PL, canEditCases, CASE_STATUS_COLOR, CASE_STATUS_PL } from "./roles";
import { useAdmin, useAdminAction, useAdminData } from "./useAdminData";

const STATUS_FILTER_PL: Record<CaseStatus, string> = { open: "Otwarte", forwarded: "Przekazane", closed: "Zamknięte" };

function StatusToken({ status }: { status: string }) {
  return <Token label={CASE_STATUS_PL[status] ?? status} color={CASE_STATUS_COLOR[status] ?? "default"} size="sm" />;
}

export default function CasesPanel() {
  const { user } = useAdmin();
  const canEdit = canEditCases(user.role);
  const [status, setStatus] = useState<CaseStatus>("open");
  const { data, error, isLoading, reload } = useAdminData(() => fetchCases(status), [status]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const selected = data?.find((c) => c.id === openId) ?? null;

  const columns: TableColumn<AdminCase>[] = [
    { key: "id", header: "Nr", width: pixel(56), renderCell: (c) => <Text hasTabularNumbers>{c.id}</Text> },
    {
      key: "representativeText",
      header: "Treść (zamaskowana)",
      // Readable floors: on a phone the table scrolls sideways instead of squeezing every column.
      width: proportional(3, { minWidth: 220 }),
      renderCell: (c) => (
        <VStack gap={1} hAlign="start">
          <Text>{c.representativeText}</Text>
          {c.note ? (
            <Text type="supporting" color="secondary">
              Notatka: {c.note}
            </Text>
          ) : null}
        </VStack>
      ),
    },
    { key: "status", header: "Status", width: pixel(120), renderCell: (c) => <StatusToken status={c.status} /> },
    { key: "senderCount", header: "Zgłaszający", align: "end", width: pixel(110), renderCell: (c) => <Text hasTabularNumbers>{String(c.senderCount)}</Text> },
    { key: "channels", header: "Kanały", width: proportional(1, { minWidth: 110 }), renderCell: (c) => <Text>{c.channels.join(", ") || "—"}</Text> },
    { key: "alertState", header: "Alert", width: proportional(1, { minWidth: 120 }), renderCell: (c) => <Text>{ALERT_STATE_PL[c.alertState] ?? c.alertState}</Text> },
    { key: "updatedAt", header: "Ostatnia zmiana", width: proportional(1, { minWidth: 150 }), renderCell: (c) => <Text>{formatDateTime(c.updatedAt)}</Text> },
    {
      key: "actions",
      header: "Szczegóły",
      width: pixel(110),
      renderCell: (c) => <Button label="Otwórz" size="sm" variant="secondary" onClick={() => setOpenId(c.id)} />,
    },
  ];

  return (
    <VStack gap={4}>
      <SectionHeader title="Kolejka spraw" actions={<Button label="Odśwież" variant="secondary" onClick={reload} isLoading={isLoading && !!data} />} />
      <Text as="p" color="secondary">
        Sprawa grupuje podobne zgłoszenia od obywateli. Treść jest zamaskowana — bez numerów telefonów i danych osobowych.
      </Text>
      <SegmentedControl label="Filtr statusu spraw" value={status} onChange={(v) => setStatus(v as CaseStatus)}>
        {CASE_STATUSES.map((s) => (
          <SegmentedControlItem key={s} value={s} label={STATUS_FILTER_PL[s]} />
        ))}
      </SegmentedControl>
      {notice ? <Banner status="success" title={notice} collapsible={false} isDismissable dismissLabel="Zamknij komunikat" onDismiss={() => setNotice("")} /> : null}
      <PanelState isLoading={isLoading} error={error} onRetry={reload} hasData={!!data} loadingLabel="Wczytuję sprawy…">
        <Table<AdminCase>
          data={data ?? []}
          columns={columns}
          idKey="id"
          verticalAlign="top"
          hasHover
          emptyState={<Text color="secondary">Brak spraw o statusie „{STATUS_FILTER_PL[status].toLowerCase()}”.</Text>}
        />
      </PanelState>
      {selected ? (
        <CaseDialog
          key={selected.id}
          item={selected}
          canEdit={canEdit}
          onClose={() => setOpenId(null)}
          onSaved={(msg) => {
            setOpenId(null);
            setNotice(msg);
            reload();
          }}
        />
      ) : null}
    </VStack>
  );
}

function CaseDialog({ item, canEdit, onClose, onSaved }: { item: AdminCase; canEdit: boolean; onClose: () => void; onSaved: (msg: string) => void }) {
  const run = useAdminAction();
  const [text, setText] = useState(item.representativeText);
  const [note, setNote] = useState(item.note ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const save = async (which: string, patch: CasePatch, msg: string) => {
    setBusy(which);
    setError("");
    const r = await run(() => patchCase(item.id, patch));
    setBusy(null);
    if (r.ok) onSaved(msg);
    else setError(r.error.message);
  };

  const edits = (): CasePatch => {
    const p: CasePatch = {};
    if (note !== (item.note ?? "")) p.note = note;
    const t = text.trim();
    if (t && t !== item.representativeText) p.representativeText = t;
    return p;
  };
  const hasEdits = Object.keys(edits()).length > 0;

  return (
    <Dialog isOpen onOpenChange={(open) => !open && onClose()} width={640} purpose="form" padding={6}>
      <VStack gap={4}>
        <DialogHeader title={`Sprawa nr ${item.id}`} subtitle={CASE_STATUS_PL[item.status] ?? item.status} onOpenChange={(open) => !open && onClose()} />
        {error ? <Banner status="error" title={error} collapsible={false} /> : null}
        <MetadataList columns="single">
          <MetadataListItem label="Status">
            <StatusToken status={item.status} />
          </MetadataListItem>
          <MetadataListItem label="Zgłaszający">{String(item.senderCount)}</MetadataListItem>
          <MetadataListItem label="Kanały">{item.channels.join(", ") || "—"}</MetadataListItem>
          <MetadataListItem label="Alert">{ALERT_STATE_PL[item.alertState] ?? item.alertState}</MetadataListItem>
          <MetadataListItem label="Utworzono">{formatDateTime(item.createdAt)}</MetadataListItem>
          <MetadataListItem label="Ostatnia zmiana">{formatDateTime(item.updatedAt)}</MetadataListItem>
        </MetadataList>
        {canEdit ? (
          <>
            <TextArea
              label="Treść reprezentatywna"
              description="Widoczna w kolejce i eksporcie. Nie wpisuj danych osobowych."
              value={text}
              onChange={setText}
              rows={3}
              maxLength={1000}
            />
            <TextArea label="Notatka moderatora" description="Tylko dla zespołu." value={note} onChange={setNote} rows={3} maxLength={2000} />
            <HStack gap={2} wrap="wrap">
              <Button
                label="Zapisz zmiany"
                variant="primary"
                isDisabled={!hasEdits}
                isLoading={busy === "save"}
                onClick={() => void save("save", edits(), `Zapisano zmiany w sprawie nr ${item.id}.`)}
              />
              {item.status !== "forwarded" ? (
                <Button
                  label="Oznacz jako przekazaną"
                  isLoading={busy === "forward"}
                  onClick={() => void save("forward", { ...edits(), status: "forwarded" }, `Sprawa nr ${item.id} oznaczona jako przekazana.`)}
                />
              ) : null}
              {item.status !== "closed" ? (
                <Button
                  label="Zamknij sprawę"
                  isLoading={busy === "close"}
                  onClick={() => void save("close", { ...edits(), status: "closed" }, `Sprawa nr ${item.id} zamknięta.`)}
                />
              ) : (
                <Button
                  label="Otwórz ponownie"
                  isLoading={busy === "reopen"}
                  onClick={() => void save("reopen", { ...edits(), status: "open" }, `Sprawa nr ${item.id} otwarta ponownie.`)}
                />
              )}
            </HStack>
          </>
        ) : (
          <VStack gap={2}>
            <Text weight="semibold">Treść reprezentatywna</Text>
            <Text as="p">{item.representativeText}</Text>
            {item.note ? (
              <Text as="p" color="secondary">
                Notatka: {item.note}
              </Text>
            ) : null}
            <Text type="supporting" color="secondary">
              Twoja rola może tylko przeglądać sprawy.
            </Text>
          </VStack>
        )}
      </VStack>
    </Dialog>
  );
}
