// Exports, API tokens, users and cache: the smaller admin tabs (Astryx `table` template rows + form fields).
import { useState } from "react";

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Selector } from "@astryxdesign/core/Selector";
import { pixel, proportional, Table, type TableColumn } from "@astryxdesign/core/Table";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { formatDateTime } from "../lib/format";
import {
  createToken,
  createUser,
  deleteUser,
  fetchExport,
  fetchTokens,
  fetchUsers,
  invalidateCache,
  isRole,
  ROLES,
  revokeToken,
  type ApiToken,
  type ExportFormat,
  type PanelUser,
  type Role,
} from "./adminApi";
import { ConfirmDialog, PanelState, saveBlob, SectionHeader } from "./parts";
import { ROLE_LABEL_PL } from "./roles";
import { useAdmin, useAdminAction, useAdminData } from "./useAdminData";

// ───────────── Eksport ─────────────

export function ExportsPanel() {
  const run = useAdminAction();
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const download = async (format: ExportFormat) => {
    setBusy(format);
    setError("");
    setDone("");
    const r = await run(() => fetchExport(format));
    setBusy(null);
    if (!r.ok) return setError(r.error.message);
    const date = new Date().toISOString().slice(0, 10);
    saveBlob(r.value, `fons-eksport-${date}.${format}`);
    setDone(`Pobrano plik ${format.toUpperCase()}.`);
  };

  return (
    <VStack gap={4}>
      <SectionHeader title="Eksport danych" />
      <Text as="p" color="secondary">
        Eksport zawiera sprawy i zagregowane wyniki sprawdzeń. Nadawcy są pseudonimizowani — nie ma w nim numerów telefonów ani treści
        wiadomości z danymi osobowymi.
      </Text>
      {error ? <Banner status="error" title={error} collapsible={false} /> : null}
      {done ? <Banner status="success" title={done} collapsible={false} /> : null}
      <HStack gap={2} wrap="wrap">
        <Button label="Pobierz CSV" variant="primary" isLoading={busy === "csv"} onClick={() => void download("csv")} />
        <Button label="Pobierz JSON" isLoading={busy === "json"} onClick={() => void download("json")} />
      </HStack>
    </VStack>
  );
}

// ───────────── Tokeny API ─────────────

export function TokensPanel() {
  const run = useAdminAction();
  const { data, error, isLoading, reload } = useAdminData(fetchTokens, []);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");
  const [created, setCreated] = useState<{ label: string; token: string } | null>(null);
  const [toRevoke, setToRevoke] = useState<ApiToken | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [notice, setNotice] = useState("");

  const create = async () => {
    const l = label.trim();
    setFormError("");
    setNotice("");
    if (!l) return setFormError("Podaj nazwę, np. „Pulpit Grafana”.");
    setCreating(true);
    const r = await run(() => createToken(l));
    setCreating(false);
    if (!r.ok) return setFormError(r.error.message);
    setCreated({ label: l, token: r.value.token });
    setLabel("");
    reload();
  };

  const revoke = async () => {
    if (!toRevoke) return;
    setRevoking(true);
    const r = await run(() => revokeToken(toRevoke.id));
    setRevoking(false);
    if (!r.ok) {
      setFormError(r.error.message);
    } else {
      setNotice(`Unieważniono token „${toRevoke.label}”.`);
      reload();
    }
    setToRevoke(null);
  };

  const columns: TableColumn<ApiToken>[] = [
    { key: "label", header: "Nazwa", width: proportional(2, { minWidth: 180 }), renderCell: (t) => <Text>{t.label}</Text> },
    { key: "role", header: "Rola", width: pixel(110), renderCell: (t) => <Text>{isRole(t.role) ? ROLE_LABEL_PL[t.role] : (t.role ?? ROLE_LABEL_PL.analityk)}</Text> },
    { key: "createdAt", header: "Utworzono", width: proportional(1, { minWidth: 150 }), renderCell: (t) => <Text>{formatDateTime(t.createdAt, "—")}</Text> },
    { key: "lastUsedAt", header: "Ostatnie użycie", width: proportional(1, { minWidth: 150 }), renderCell: (t) => <Text>{formatDateTime(t.lastUsedAt, "nie używano")}</Text> },
    {
      key: "actions",
      header: "Akcje",
      width: pixel(130),
      renderCell: (t) => <Button label="Unieważnij" size="sm" variant="destructive" onClick={() => setToRevoke(t)} />,
    },
  ];

  return (
    <VStack gap={4}>
      <SectionHeader title="Tokeny API" actions={<Button label="Odśwież" variant="secondary" onClick={reload} isLoading={isLoading && !!data} />} />
      <Text as="p" color="secondary">
        Token pozwala integracji (serwer MCP, pulpit metryk) czytać dane z rolą analityka. Wysyłaj go w nagłówku Authorization: Bearer. Działa dla
        /mcp i /metrics.
      </Text>
      <Card padding={4}>
        <VStack gap={3}>
          <Heading level={4} accessibilityLevel={3}>
            Nowy token
          </Heading>
          {formError ? <Banner status="error" title={formError} collapsible={false} /> : null}
          <HStack gap={2} wrap="wrap" vAlign="end">
            <TextInput label="Nazwa tokenu" value={label} onChange={setLabel} onEnter={() => void create()} placeholder="np. Klient MCP — zespół analiz" />
            <Button label="Utwórz token" variant="primary" isLoading={creating} onClick={() => void create()} />
          </HStack>
          {created ? (
            <Banner
              status="warning"
              title={`Token „${created.label}” — skopiuj go teraz`}
              description="Pokazujemy go tylko raz. Po zamknięciu tej informacji nie da się go odczytać — trzeba utworzyć nowy."
              collapsible={false}
              isDismissable
              dismissLabel="Zamknij — skopiowałem token"
              onDismiss={() => setCreated(null)}>
              <CodeBlock code={created.token} title="Token API" hasLanguageLabel={false} isWrapped width="100%" />
            </Banner>
          ) : null}
        </VStack>
      </Card>
      {notice ? <Banner status="success" title={notice} collapsible={false} /> : null}
      <PanelState isLoading={isLoading} error={error} onRetry={reload} hasData={!!data} loadingLabel="Wczytuję tokeny…">
        <Table<ApiToken> data={data ?? []} columns={columns} idKey="id" emptyState={<Text color="secondary">Nie ma jeszcze żadnych tokenów.</Text>} />
      </PanelState>
      <ConfirmDialog
        isOpen={!!toRevoke}
        title="Unieważnić token?"
        description={`Integracja korzystająca z tokenu „${toRevoke?.label ?? ""}” straci dostęp od razu. Tego nie da się cofnąć.`}
        confirmLabel="Unieważnij"
        isBusy={revoking}
        onConfirm={() => void revoke()}
        onCancel={() => setToRevoke(null)}
      />
    </VStack>
  );
}

// ───────────── Użytkownicy ─────────────

const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: ROLE_LABEL_PL[r] }));
const ROLE_COLOR: Record<Role, "blue" | "teal" | "purple"> = { moderator: "blue", analityk: "teal", administrator: "purple" };

export function UsersPanel() {
  const { user: me } = useAdmin();
  const run = useAdminAction();
  const { data, error, isLoading, reload } = useAdminData(fetchUsers, []);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("moderator");
  const [password, setPassword] = useState("");
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [toRemove, setToRemove] = useState<PanelUser | null>(null);
  const [removing, setRemoving] = useState(false);

  const add = async () => {
    setFormError("");
    setNotice("");
    const u = username.trim();
    if (!u) return setFormError("Podaj nazwę użytkownika.");
    if (password.length < 12) return setFormError("Hasło musi mieć co najmniej 12 znaków.");
    setAdding(true);
    const r = await run(() => createUser({ username: u, role, password }));
    setAdding(false);
    if (!r.ok) return setFormError(r.error.message);
    setNotice(`Dodano użytkownika „${u}” z rolą ${ROLE_LABEL_PL[role].toLowerCase()}.`);
    setUsername("");
    setPassword("");
    reload();
  };

  const remove = async () => {
    if (!toRemove) return;
    setRemoving(true);
    const r = await run(() => deleteUser(toRemove.username));
    setRemoving(false);
    if (!r.ok) setFormError(r.error.message);
    else {
      setNotice(`Usunięto użytkownika „${toRemove.username}”.`);
      reload();
    }
    setToRemove(null);
  };

  const columns: TableColumn<PanelUser>[] = [
    { key: "username", header: "Użytkownik", width: proportional(2, { minWidth: 160 }), renderCell: (u) => <Text>{u.username === me.username ? `${u.username} (Ty)` : u.username}</Text> },
    {
      key: "role",
      header: "Rola",
      width: pixel(140),
      renderCell: (u) => (isRole(u.role) ? <Token label={ROLE_LABEL_PL[u.role]} color={ROLE_COLOR[u.role]} size="sm" /> : <Text>{u.role}</Text>),
    },
    { key: "createdAt", header: "Utworzono", width: proportional(1, { minWidth: 150 }), renderCell: (u) => <Text>{formatDateTime(u.createdAt, "—")}</Text> },
    {
      key: "actions",
      header: "Akcje",
      width: pixel(100),
      renderCell: (u) => (
        <Button
          label="Usuń"
          size="sm"
          variant="destructive"
          isDisabled={u.username === me.username}
          tooltip={u.username === me.username ? "Nie możesz usunąć własnego konta." : undefined}
          onClick={() => setToRemove(u)}
        />
      ),
    },
  ];

  return (
    <VStack gap={4}>
      <SectionHeader title="Użytkownicy panelu" actions={<Button label="Odśwież" variant="secondary" onClick={reload} isLoading={isLoading && !!data} />} />
      <Text as="p" color="secondary">
        Obywatele nie logują się — konta są tylko dla zespołu: moderator prowadzi sprawy, analityk widzi metryki i eksport, administrator ma pełny
        dostęp.
      </Text>
      <Card padding={4}>
        <VStack gap={3}>
          <Heading level={4} accessibilityLevel={3}>
            Dodaj użytkownika
          </Heading>
          {formError ? <Banner status="error" title={formError} collapsible={false} /> : null}
          <Grid columns={{ minWidth: 200, repeat: "fit" }} gap={3}>
            <TextInput label="Nazwa użytkownika" value={username} onChange={setUsername} autoComplete="off" />
            <Selector label="Rola" options={ROLE_OPTIONS} value={role} onChange={(v) => v && isRole(v) && setRole(v)} />
            <TextInput
              label="Hasło początkowe"
              description="Co najmniej 12 znaków."
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              onEnter={() => void add()}
            />
          </Grid>
          <HStack>
            <Button label="Dodaj użytkownika" variant="primary" isLoading={adding} onClick={() => void add()} />
          </HStack>
        </VStack>
      </Card>
      {notice ? <Banner status="success" title={notice} collapsible={false} /> : null}
      <PanelState isLoading={isLoading} error={error} onRetry={reload} hasData={!!data} loadingLabel="Wczytuję użytkowników…">
        <Table<PanelUser> data={data ?? []} columns={columns} idKey="username" emptyState={<Text color="secondary">Brak użytkowników.</Text>} />
      </PanelState>
      <ConfirmDialog
        isOpen={!!toRemove}
        title="Usunąć użytkownika?"
        description={`Konto „${toRemove?.username ?? ""}” straci dostęp do panelu od razu.`}
        confirmLabel="Usuń"
        isBusy={removing}
        onConfirm={() => void remove()}
        onCancel={() => setToRemove(null)}
      />
    </VStack>
  );
}

// ───────────── Pamięć podręczna ─────────────

export function CachePanel() {
  const run = useAdminAction();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const clear = async (k?: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    const r = await run(() => invalidateCache(k));
    setBusy(false);
    setConfirmAll(false);
    if (!r.ok) return setError(r.error.message);
    const removed = typeof r.value.removed === "number" ? ` Usunięto wpisów: ${r.value.removed}.` : "";
    setNotice(k ? `Wyczyszczono wpis „${k}”.${removed}` : `Wyczyszczono całą pamięć podręczną.${removed}`);
    setKey("");
  };

  return (
    <VStack gap={4}>
      <SectionHeader title="Pamięć podręczna wyników" />
      <List listStyle="disc" density="compact">
        <ListItem label={<Text>To samo pytanie w ciągu kilku godzin dostaje zapisany wynik — szybciej i taniej.</Text>} />
        <ListItem label={<Text>Wyczyść ją po aktualizacji bazy źródeł albo gdy wynik okazał się błędny.</Text>} />
      </List>
      {error ? <Banner status="error" title={error} collapsible={false} /> : null}
      {notice ? <Banner status="success" title={notice} collapsible={false} /> : null}
      <HStack gap={2} wrap="wrap" vAlign="end">
        <TextInput label="Klucz wpisu (opcjonalnie)" description="Pusty = cała pamięć." value={key} onChange={setKey} />
        <Button
          label={key.trim() ? "Wyczyść ten wpis" : "Wyczyść wszystko"}
          variant={key.trim() ? "primary" : "destructive"}
          isLoading={busy && !confirmAll}
          onClick={() => (key.trim() ? void clear(key.trim()) : setConfirmAll(true))}
        />
      </HStack>
      <ConfirmDialog
        isOpen={confirmAll}
        title="Wyczyścić całą pamięć podręczną?"
        description="Kolejne pytania zostaną sprawdzone od nowa, co potrwa dłużej i będzie kosztować więcej."
        confirmLabel="Wyczyść wszystko"
        isBusy={busy}
        onConfirm={() => void clear()}
        onCancel={() => setConfirmAll(false)}
      />
    </VStack>
  );
}
