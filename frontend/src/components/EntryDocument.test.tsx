// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryDocument, SignatureCard } from "./EntryDocument";
import { DETAIL_FIELDS } from "../lib/reportForm";

/**
 * What the document says of an entry and how the signature card words it. The layout, the touch targets and the whole page are
 * covered by the Playwright suite (e2e/entry-as-document.spec.ts); this is what can be seen without a browser.
 */
afterEach(cleanup);

const entry = {
  workDescription: "Betonáž stropní desky.\nDruhý řádek.",
  workersByTrade: JSON.stringify([
    { trade: "Zedník", count: 4, names: ["Jan Novák", "Petr Svoboda"] },
    { trade: "Železář", count: 3 },
  ]),
  weatherText: "zataženo, 8,5 až 15 °C",
  details: { materials: "Beton C25/30", safetyNotes: "Poučení v 7:00" },
  isLateEntry: false,
  lateEntryReason: null,
};

describe("EntryDocument", () => {
  it("is text, not a form: nothing to type into and nothing disabled", () => {
    const { container } = render(<EntryDocument entry={entry} />);

    expect(container.querySelectorAll("input, textarea, select, button, [disabled]")).toHaveLength(0);
    expect(screen.queryByText(/např\./)).toBeNull();
  });

  it("prints what was written in full, under a heading for each part", () => {
    render(<EntryDocument entry={entry} />);

    for (const name of ["Popis prací", "Pracovníci podle profesí", "Počasí", "Další zápisy"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
    }
    expect(screen.getByText(/Betonáž stropní desky\./).textContent).toBe("Betonáž stropní desky.\nDruhý řádek.");
    expect(screen.getByText("zataženo, 8,5 až 15 °C")).toBeTruthy();
    expect(screen.getByText("Beton C25/30")).toBeTruthy();
    expect(screen.getByText("Poučení v 7:00")).toBeTruthy();
  });

  it("shows the trades as a table with the names and the total of the people", () => {
    render(<EntryDocument entry={entry} />);

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows.map((row) => row.textContent)).toEqual(["ProfesePočetJména", "Zedník4Jan Novák; Petr Svoboda", "Železář3neuvedena"]);
    expect(screen.getByText("Celkem pracovníků: 7")).toBeTruthy();
  });

  it("names the fields that say nothing in one line, and does not list the filled ones in it", () => {
    render(<EntryDocument entry={entry} />);

    const line = screen.getByText(/^Bez záznamu: /);
    const empty = DETAIL_FIELDS.filter((f) => f.key !== "materials" && f.key !== "safetyNotes");
    for (const field of empty) expect(line.textContent, field.key).toContain(field.label);
    expect(line.textContent).not.toContain(DETAIL_FIELDS.find((f) => f.key === "materials")!.label);
    // ... and they are not shown as empty fields (as headings or labels) as well
    expect(screen.getAllByText(DETAIL_FIELDS.find((f) => f.key === "materials")!.label)).toHaveLength(1);
  });

  it("says so, once, when nothing is written at all", () => {
    render(<EntryDocument entry={{ workDescription: "  ", workersByTrade: "[]", weatherText: null, details: {}, isLateEntry: false }} />);

    expect(screen.getAllByText("Bez záznamu.")).toHaveLength(2); // the work and the trades
    expect(screen.getByText("Neuvedeno.")).toBeTruthy();
    const line = screen.getByText(/^Bez záznamu: /);
    for (const field of DETAIL_FIELDS) expect(line.textContent, field.key).toContain(field.label);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("gives the reason of a late entry its own part, and only for a late entry", () => {
    const { rerender } = render(<EntryDocument entry={{ ...entry, isLateEntry: true, lateEntryReason: "Deník byl na jiné stavbě." }} />);
    expect(screen.getByRole("heading", { level: 2, name: "Důvod pozdního zápisu" })).toBeTruthy();
    expect(screen.getByText("Deník byl na jiné stavbě.")).toBeTruthy();

    rerender(<EntryDocument entry={{ ...entry, isLateEntry: false, lateEntryReason: "Zbytek z dřívějška" }} />);
    expect(screen.queryByText("Důvod pozdního zápisu")).toBeNull();
    expect(screen.queryByText("Zbytek z dřívějška")).toBeNull();
  });
});

describe("SignatureCard", () => {
  const card = (props: Partial<React.ComponentProps<typeof SignatureCard>> = {}) => (
    <SignatureCard
      signerName="Jan Stavbyvedoucí"
      signerCkaitNumber="0012345"
      signerFrozen
      signedAt="2026-09-28T12:32:07.123Z"
      sequenceNumber={7}
      signatureHash={"ab".repeat(32)}
      canCheck
      check={null}
      onCheck={() => undefined}
      {...props}
    />
  );

  it("says who signed, with the number, when (Prague time with its zone), and which entry, without anything being pressed", () => {
    render(card());

    const region = screen.getByRole("region", { name: "Podpis záznamu" });
    expect(within(region).getByText("Jan Stavbyvedoucí, ČKAIT 0012345")).toBeTruthy();
    expect(within(region).getByText("28. 9. 2026 14:32:07 SELČ (UTC+2)")).toBeTruthy();
    expect(within(region).getByText("7")).toBeTruthy();
    expect(within(region).getByText(/Otisk obsahu \(SHA-256\)/)).toBeTruthy();
    expect(within(region).getByText("ab".repeat(32))).toBeTruthy();
  });

  it("never says the word of the state badge as a whole text: there is one element for it on the page", () => {
    const { container } = render(card());

    const all = Array.from(container.querySelectorAll("*")).filter((el) => el.children.length === 0 && el.textContent?.trim() === "Podepsáno");
    expect(all).toHaveLength(0);
  });

  it("says when the signer is the account as it is now (an entry that kept no copy), and not when it is the stored one", () => {
    const { rerender } = render(card({ signerFrozen: false }));
    expect(screen.getByText("(podle účtu, jak je dnes)")).toBeTruthy();

    rerender(card({ signerFrozen: true }));
    expect(screen.queryByText("(podle účtu, jak je dnes)")).toBeNull();
  });

  it("does not invent a signer, and does not hide that there is none", () => {
    render(card({ signerName: null, signerCkaitNumber: null, signedAt: null, sequenceNumber: null, signatureHash: null }));

    expect(screen.getByText("Jméno podepisujícího se nepodařilo zjistit")).toBeTruthy();
    expect(screen.getByText("neznámý")).toBeTruthy();
    expect(screen.queryByText(/Číslo záznamu/)).toBeNull();
    expect(screen.queryByText(/Otisk obsahu/)).toBeNull();
  });

  it("says that the data is on its way right after signing", () => {
    render(card({ loading: true, signerName: null, signedAt: null }));

    expect(screen.getByText("Načítám údaje o podpisu…")).toBeTruthy();
    expect(screen.queryByText("Jméno podepisujícího se nepodařilo zjistit")).toBeNull();
  });

  it("verifies on request, and shows what was found as the one status of the page", () => {
    const onCheck = vi.fn();
    const { rerender } = render(card({ onCheck }));
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ověřit podpis" }));
    expect(onCheck).toHaveBeenCalledTimes(1);

    rerender(
      card({ onCheck, check: { signed: true, signedByName: "Jan Stavbyvedoucí", signerCkaitNumber: "0012345", signerFrozen: true, contentMatches: true, photoFilesMatch: null } }),
    );
    expect(screen.getByRole("status").textContent).toContain("Podepsal Jan Stavbyvedoucí, ČKAIT 0012345 (jméno a číslo uložené při podpisu). Obsah odpovídá podpisu.");

    rerender(card({ onCheck, check: { signed: true, contentMatches: false, photoFilesMatch: null } }));
    expect(screen.getByRole("status").textContent).toContain("POZOR: obsah záznamu se po podpisu změnil.");
  });

  it("has no button to verify when there is nothing to verify against, and shows what a reader may do next to it", () => {
    render(card({ canCheck: false, children: <button>Potvrdit seznámení</button> }));

    expect(screen.queryByRole("button", { name: "Ověřit podpis" })).toBeNull();
    expect(screen.getByRole("button", { name: "Potvrdit seznámení" })).toBeTruthy();
  });

  it("says when what the server knows of the signature could not be loaded, and tries again on request, instead of loading for ever", () => {
    const onRetry = vi.fn();
    const { rerender } = render(card({ loading: false, loadFailed: true, onRetry, signerName: null, signedAt: null }));

    expect(screen.getByText("Údaje o podpisu se nepodařilo načíst.")).toBeTruthy();
    expect(screen.queryByText("Načítám údaje o podpisu…")).toBeNull();
    expect(screen.queryByText("Jméno podepisujícího se nepodařilo zjistit"), "no half-made signer next to the failure").toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Zkusit znovu" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    // While it tries again, it says it is loading, and offers nothing to press.
    rerender(card({ loading: true, loadFailed: false, onRetry, signerName: null, signedAt: null }));
    expect(screen.getByText("Načítám údaje o podpisu…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Zkusit znovu" })).toBeNull();
  });

  it("says that the signer is incomplete when the signature lacks the name or the number, and says nothing of it otherwise", () => {
    const { rerender } = render(card({ signerIncomplete: true, signerCkaitNumber: null }));

    const notice = screen.getByText("Údaje o podepisujícím jsou neúplné; ověřte podpis.");
    expect(notice.getAttribute("role"), "a notice, not a second status next to the verification").toBeNull();
    expect(screen.getByText("Jan Stavbyvedoucí")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ověřit podpis" })).toBeTruthy();

    rerender(card({ signerIncomplete: false }));
    expect(screen.queryByText(/neúplné/)).toBeNull();
    rerender(card());
    expect(screen.queryByText(/neúplné/)).toBeNull();
  });
});
