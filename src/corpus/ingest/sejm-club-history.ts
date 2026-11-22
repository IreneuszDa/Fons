import type { CorpusRecord } from "../../shared/contracts";
import { type baseFromCatalog, recordId } from "./common";
import type { SejmMp } from "./sejm-mp";

interface VoteRef { term: number; sitting: number; votingNumber: number }
export interface RollCall extends VoteRef {
  date: string;
  votes: { MP: number; firstName: string; lastName: string; club: string }[];
}

// A dated observation from a published roll call. The list can be extended with observations from other terms.
export const CLUB_ROLL_CALLS: VoteRef[] = [{ term: 10, sitting: 44, votingNumber: 5 }];
export const rollCallUrl = (vote: VoteRef) =>
  `https://api.sejm.gov.pl/sejm/term${vote.term}/votings/${vote.sitting}/${vote.votingNumber}`;
export const clubHistoryId = (url: string, mp: number) => recordId("sejm-eli", `${url}|club|MP/${mp}`);

export function clubHistoryRecords(ref: VoteRef, roll: RollCall, members: SejmMp[],
  base: ReturnType<typeof baseFromCatalog>, publisher: string, fetchedAt: string): CorpusRecord[] {
  if (ref.term !== roll.term || ref.sitting !== roll.sitting || ref.votingNumber !== roll.votingNumber ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(roll.date) || !roll.votes?.length ||
      new Set(roll.votes.map(v => v.MP)).size !== roll.votes.length) throw new Error("Niespójne metadane imiennego głosowania Sejmu");
  const people = new Map(members.filter(mp => mp.active).map(mp => [mp.id, mp]));
  const date = roll.date.slice(0, 10);
  if (!(Date.parse(date) <= Date.parse(fetchedAt))) throw new Error("Nieprawidłowa data głosowania Sejmu");
  const url = rollCallUrl(ref);
  return roll.votes.flatMap(vote => {
    const mp = people.get(vote.MP);
    if (!mp || !mp.club || !vote.club || mp.club === vote.club) return [];
    const name = `${vote.firstName} ${vote.lastName}`;
    return [{
      ...base, publisher, url, id: clubHistoryId(url, mp.id),
      title: `Sejm: ${name} — klub lub koło w dniu ${date}`,
      text: `W imiennym wykazie głosowania Sejmu z ${date} przy osobie ${name} (MP ${mp.id}) widnieje klub lub koło: ${vote.club}.`,
      topics: ["generated-from-data", "sejm", "posel", "klub-poselski", "imienne-glosowanie", vote.club.toLowerCase()],
      lang: "pl" as const, publishedAt: null, period: date, fetchedAt, origin: "corpus" as const,
    }];
  });
}
