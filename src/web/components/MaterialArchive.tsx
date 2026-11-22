import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Selector } from "@astryxdesign/core/Selector";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { ArchiveMaterial, SavedMaterial } from "../../shared/archive";
import { ApiError, NETWORK_ERROR_PL, previewArchive, readArchives, removeArchive, saveArchive } from "../api";
import { formatDate, formatDateTime } from "../lib/format";

function Fragment({ material }: { material: ArchiveMaterial }) {
  return <VStack gap={1}>
    <Text as="p">{material.excerpt}</Text>
    <Text type="supporting">{material.attribution} Aktualizacja źródła {formatDate(material.publishedAt)}. Pobrano {formatDateTime(material.fetchedAt)}.</Text>
    <Link href={material.url} isExternalLink rel="noopener noreferrer">{material.publisher}</Link>
    <Link href={material.termsUrl} isExternalLink rel="noopener noreferrer">Warunki ponownego wykorzystania</Link>
  </VStack>;
}

const errorText = (err: unknown) => err instanceof ApiError ? err.messagePl : NETWORK_ERROR_PL;

export function MaterialArchive({ initialUrl = "", recordId }: { initialUrl?: string; recordId?: string }) {
  const [url, setUrl] = useState(initialUrl);
  const [options, setOptions] = useState<ArchiveMaterial[]>([]);
  const [selection, setSelection] = useState<string | null>(null);
  const [items, setItems] = useState<SavedMaterial[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(true);
  const current = options.find(item => item.recordId === selection);

  useEffect(() => {
    let live = true;
    readArchives().then(data => { if (live) setItems(data.items); })
      .catch(err => { if (live) setMessage(errorText(err)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, []);

  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try { await operation(); } catch (err) { setMessage(errorText(err)); } finally { setBusy(false); }
  }

  async function preview() {
    setOptions([]);
    setSelection(null);
    const { items } = await previewArchive(url.trim());
    setOptions(items);
    setSelection((items.find(item => item.recordId === recordId) ?? items[0])?.recordId ?? null);
    if (!items.length) setMessage("Pod tym adresem nie ma fragmentu dopuszczonego do archiwizacji.");
  }

  return <VStack gap={3} paddingBlock={2}>
    <Text as="p">Wklej adres serii z API Eurostatu lub Banku Danych Lokalnych GUS użytej w raporcie. Fons może zapisać wybrany opis danych na serwerze na 7 dni. Dostęp do zapisu daje prywatne ciasteczko tej przeglądarki.</Text>
    <TextInput type="url" label="Adres materiału" value={url} isDisabled={busy} onChange={value => { setUrl(value); setOptions([]); setMessage(""); }}
      onEnter={() => { if (url.trim()) void act(preview); }} />
    <Button label="Pokaż dostępne fragmenty" isDisabled={busy || !url.trim()} onClick={() => void act(preview)} />
    {options.length > 0 && <Selector label="Fragment materiału" value={selection} isDisabled={busy} hasSearch hasClear
      searchPlaceholder="Szukaj fragmentu" emptySearchText="Brak wyników" options={options.map(item => ({ value: item.recordId, label: item.title }))} onChange={setSelection} />}
    {current && <>
      <Fragment material={current} />
      <Button label="Zapisz fragment na 7 dni" variant="primary" isDisabled={busy || items.some(item => item.sha256 === current.sha256)} onClick={() => void act(async () => {
        const { item } = await saveArchive(current);
        setItems(prev => [item, ...prev.filter(x => x.id !== item.id)]);
        setMessage("Fragment zapisany w Twoim archiwum.");
      })} />
    </>}
    {message && <Text as="p" role="status">{message}</Text>}
    {items.length > 0 && <>
      <Heading level={3}>Zapisane fragmenty</Heading>
      <List hasDividers>{items.map(item => <ListItem key={item.id} label={<Text weight="semibold">{item.title}</Text>} description={
        <VStack gap={2}>
          <Fragment material={item} />
          <Text type="supporting">Dostępny do {formatDateTime(item.expiresAt)}.</Text>
          <Button label="Usuń fragment" size="sm" isDisabled={busy} onClick={() => void act(async () => {
            await removeArchive(item.id);
            setItems(prev => prev.filter(x => x.id !== item.id));
            setMessage("Fragment usunięty.");
          })} />
        </VStack>
      } />)}</List>
    </>}
  </VStack>;
}
