import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { expect, it, vi } from "vitest";
import ChatHistory, { HistoryList } from "./ChatHistory";

it("offers independent open and delete controls for each real conversation", () => {
  const chats = [
    { id: "older", title: "Pierwsza sprawa", updatedAt: "2026-11-21T22:00:00Z" },
    { id: "current", title: "Druga sprawa", updatedAt: "2026-11-22T00:00:00Z" },
  ];
  const markup = renderToStaticMarkup(
    <HistoryList chats={chats} activeId="current" onOpen={vi.fn()} onNew={vi.fn()} onRequestDelete={vi.fn()} />,
  );
  const { document } = parseHTML(markup);
  const nav = document.querySelector('[role="navigation"][aria-label="Historia czatów"]')!;
  expect(nav.querySelector("button")?.textContent).toContain("Nowy czat");
  const rows = nav.querySelector('[role="group"]')!.querySelectorAll(".astryx-side-nav-item");
  expect(rows.length).toBe(2);
  for (const [index, row] of Array.from(rows).entries()) {
    const [openChat, deleteChat] = Array.from(row.querySelectorAll("button"));
    expect(openChat?.textContent).toContain(chats[index]!.title);
    expect(openChat?.contains(deleteChat!)).toBe(false);
    expect(openChat?.getAttribute("aria-current")).toBe(index === 1 ? "page" : null);
    expect(deleteChat?.getAttribute("aria-label")).toBe(`Usuń czat „${chats[index]!.title}”`);
  }
});

it("keeps history behind one closed trigger even inside a conversation", () => {
  const { document } = parseHTML(renderToStaticMarkup(
    <ChatHistory chats={[]} activeId="current" onOpen={vi.fn()} onNew={vi.fn()} onDelete={vi.fn()}>
      Treść wybranej rozmowy
    </ChatHistory>,
  ));
  expect(document.querySelector('button[aria-label="Historia czatów"]')?.getAttribute("aria-expanded")).toBe("false");
  const history = document.querySelector('[role="navigation"][aria-label="Historia czatów"]');
  expect(history?.closest('[inert][aria-hidden="true"]')).toBeTruthy();
});
