// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Handover, HandoverSignature } from "../lib/handovers";
import { Handovers } from "./Handovers";

/**
 * What the handover tab offers to whom, and what it does with the answers of the server. The server decides everything (these
 * tests make it say what the real one says); what is checked here is that a person is offered what their role allows and nothing
 * else, that a wrong password stays in the dialog, and that a version that is out of date or a side that somebody else signed is
 * said on the page, which then loads again. Focus, the backdrop and the real `showModal` are covered by e2e/legislative.spec.ts.
 */
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    setTimeout(() => this.dispatchEvent(new Event("close")), 0);
  };
});

const draft: Handover = {
  id: "h1",
  type: "Předání staveniště zhotoviteli",
  date: "2026-09-11",
  participants: "Novák, Svoboda",
  meterStates: [{ medium: "Elektřina VT", serialNumber: "EL-98765", state: "12450 kWh" }],
  notes: "Bez výhrad",
  createdById: "boss-id",
  updatedAt: "2026-09-11T08:00:00.123456Z",
  state: "DRAFT",
};

const signature = (side: "CONTRACTOR" | "CLIENT", by = "boss-id"): HandoverSignature => ({
  side,
  signedById: by,
  signerName: side === "CONTRACTOR" ? "Ing. Karel Dvořák" : "Marie Stavebníková",
  signerRole: side === "CONTRACTOR" ? "BOSS" : "INVESTOR",
  signerCkaitNumber: side === "CONTRACTOR" ? "0012345" : null,
  signedAt: "2026-09-12T10:15:30.123Z",
  contentHash: "a".repeat(64),
  signatureHash: "b".repeat(64),
});

const byContractor: Handover = { ...draft, state: "SIGNED_BY_CONTRACTOR", contractorSignature: signature("CONTRACTOR") };

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The server as a script: `reply(method, path)` answers a request, and every request is kept. */
function serve(reply: (method: string, path: string, body: unknown) => Response) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      return reply(method, path, body);
    }),
  );
  return calls;
}

function signInAs(id: string) {
  localStorage.setItem("user", JSON.stringify({ id, nickname: id, displayName: id, role: "BOSS", isAdmin: false }));
}

beforeEach(() => signInAs("boss-id"));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const list =
  (...items: Handover[]) =>
  (method: string, path: string) =>
    method === "GET" && path.endsWith("/handovers") ? answer(200, items) : answer(404, { error: "?" });

describe("what the tab offers", () => {
  it("is the contractor's signature to a manager, the client's to an investor or the supervision, and none to a worker", async () => {
    serve(list(draft));
    for (const [role, sign] of [
      ["BOSS", "Podepsat za zhotovitele"],
      ["INVESTOR", "Podepsat za stavebníka"],
      ["INSPECTOR", "Podepsat za stavebníka"],
      ["WORKER", null],
      [null, null],
    ] as const) {
      const { unmount } = render(<Handovers projectId="p1" myRole={role} />);
      await screen.findByText(draft.type);
      const buttons = screen.queryAllByRole("button", { name: /^Podepsat za/ }).map((b) => b.textContent);
      expect(buttons, `a ${role} signs`).toEqual(sign ? [sign] : []);
      unmount();
    }
  });

  it("is a new protocol and a change to the people who write one, and only until a party has signed", async () => {
    serve(list(draft, { ...byContractor, id: "h2", type: "Podepsaný" }));
    const { unmount } = render(<Handovers projectId="p1" myRole="BOSS" />);
    await screen.findByText("Podepsaný");
    expect(screen.getByRole("button", { name: "Přidat předání" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Upravit" }), "only the protocol that nobody signed can be changed").toHaveLength(1);
    unmount();

    for (const role of ["INVESTOR", "INSPECTOR", null]) {
      const view = render(<Handovers projectId="p1" myRole={role} />);
      await screen.findByText("Podepsaný");
      expect(screen.queryByRole("button", { name: "Přidat předání" }), `${role} makes none`).toBeNull();
      expect(screen.queryByRole("button", { name: "Upravit" }), `${role} changes none`).toBeNull();
      view.unmount();
    }
  });

  it("is the state of the protocol and of each side, and the signer who signed it", async () => {
    serve(
      list(byContractor, {
        ...draft,
        id: "h3",
        type: "Hotové",
        state: "COMPLETE",
        contractorSignature: signature("CONTRACTOR"),
        clientSignature: signature("CLIENT", "investor-id"),
      }),
    );
    render(<Handovers projectId="p1" myRole="WORKER" />);

    await screen.findByText("Podepsal zhotovitel, čeká na stavebníka");
    expect(screen.getByText("Podepsáno oběma stranami")).toBeTruthy();
    expect(screen.getAllByText(/Podepsal\(a\) Ing\. Karel Dvořák \(Stavbyvedoucí, ČKAIT 0012345\)/)).toHaveLength(2);
    expect(screen.getByText(/Podepsal\(a\) Marie Stavebníková \(Investor\),/)).toBeTruthy();
    expect(screen.getAllByText("Čeká na podpis"), "the side that has not signed says so").toHaveLength(1);
    expect(screen.getAllByText(/^a{64}$/), "the hash both parties signed is shown under each protocol that has a signature").toHaveLength(2);
  });

  it("does not offer the other side to a person who signed one (their role changed in between)", async () => {
    signInAs("boss-id");
    serve(list(byContractor));
    render(<Handovers projectId="p1" myRole="INVESTOR" />);
    await screen.findByText(draft.type);
    expect(screen.queryByRole("button", { name: /^Podepsat za/ })).toBeNull();
  });
});

describe("signing", () => {
  async function openSignDialog(role: string, reply: (method: string, path: string, body: unknown) => Response) {
    const calls = serve(reply);
    render(<Handovers projectId="p1" myRole={role} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Podepsat za/ }));
    const dialog = await screen.findByRole("dialog", { name: /^Podepsat předání za/ });
    return { calls, dialog };
  }

  const type = (dialog: HTMLElement, password: string) => fireEvent.change(within(dialog).getByLabelText("Heslo"), { target: { value: password } });
  const submit = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole("button", { name: "Podepsat" }));

  it("shows what is signed, asks for the password, and sends the side, the password and the version that was on the screen", async () => {
    const { calls, dialog } = await openSignDialog("BOSS", (method, path) =>
      method === "POST" && path === "/api/handovers/h1/sign" ? answer(200, byContractor) : list(draft)(method, path),
    );
    expect(within(dialog).getByText("Novák, Svoboda"), "the dialog shows what is signed").toBeTruthy();
    expect(within(dialog).getByText(/Elektřina VT/)).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Podepsat" }) as HTMLButtonElement).disabled, "nothing to send without the password").toBe(true);

    type(dialog, "Password123!");
    submit(dialog);

    await screen.findByText("Podepsal zhotovitel, čeká na stavebníka");
    const sign = calls.find((c) => c.method === "POST")!;
    expect(sign.body).toEqual({ side: "CONTRACTOR", password: "Password123!", expectedUpdatedAt: draft.updatedAt });
    expect(screen.getByText(/jste podepsal\(a\) za zhotovitele/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Podepsat za/ }), "its side is signed, so there is nothing more to offer").toBeNull();
    expect(screen.queryByRole("button", { name: "Upravit" }), "and the protocol cannot be changed any more").toBeNull();
  });

  it("keeps the dialog open and says so when the password is wrong, and the person can try again", async () => {
    let attempts = 0;
    const { dialog } = await openSignDialog("INVESTOR", (method, path) => {
      if (method === "POST")
        return ++attempts === 1 ? answer(400, { error: "Heslo není správné." }) : answer(200, { ...draft, state: "SIGNED_BY_CLIENT", clientSignature: signature("CLIENT", "me") });
      return list(draft)(method, path);
    });

    type(dialog, "špatně");
    submit(dialog);
    expect(await within(dialog).findByText("Heslo není správné.")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /^Podepsat předání za/ }), "still there").toBeTruthy();
    expect(screen.queryByText("Podepsal stavebník, čeká na zhotovitele")).toBeNull();

    type(dialog, "Password123!");
    submit(dialog);
    await screen.findByText("Podepsal stavebník, čeká na zhotovitele");
  });

  it("says that the protocol changed meanwhile when the version is out of date, and loads it again", async () => {
    let loaded = 0;
    const { calls } = await openSignDialog("BOSS", (method) => {
      if (method === "POST") return answer(409, { error: "Protokol mezitím změnil někdo jiný. Načtěte jej znovu a zkontrolujte, co podepisujete.", code: "STALE_VERSION" });
      loaded++;
      return answer(200, [loaded === 1 ? draft : { ...draft, notes: "Změněno jinou osobou", updatedAt: "2026-09-11T09:00:00Z" }]);
    });
    const dialog = screen.getByRole("dialog", { name: /^Podepsat předání za/ });

    type(dialog, "Password123!");
    submit(dialog);

    const banner = await screen.findByText(/mezitím změnil někdo jiný/);
    expect(banner).toBeTruthy();
    expect(screen.queryByRole("dialog"), "the dialog is closed: what it showed is not what would be signed").toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Načíst aktuální stav" }));
    await screen.findByText("Změněno jinou osobou");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(screen.queryByText(/mezitím změnil někdo jiný/), "the notice goes away with the reload").toBeNull();
  });

  it("closes the dialog and says so when somebody signed that side first", async () => {
    await openSignDialog("BOSS", (method, path) =>
      method === "POST" ? answer(409, { error: "Za zhotovitele už protokol podepsal(a) Ing. Zdeněk Zástupce." }) : list(draft)(method, path),
    );
    const dialog = screen.getByRole("dialog", { name: /^Podepsat předání za/ });

    type(dialog, "Password123!");
    submit(dialog);

    await screen.findByText(/už protokol podepsal\(a\) Ing\. Zdeněk Zástupce/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says why a manager without a ČKAIT number cannot sign, in the dialog", async () => {
    const { dialog } = await openSignDialog("BOSS", (method, path) =>
      method === "POST" ? answer(403, { error: "K podpisu předání za zhotovitele je nutné číslo ČKAIT.", code: "SIGNER_NOT_QUALIFIED" }) : list(draft)(method, path),
    );

    type(dialog, "Password123!");
    submit(dialog);

    expect(await within(dialog).findByText(/je nutné číslo ČKAIT/)).toBeTruthy();
  });
});

describe("making and changing a protocol", () => {
  it("sends a new protocol trimmed, without the empty meter rows, and shows it first", async () => {
    const created: Handover = { ...draft, id: "h9", type: "Nový typ" };
    const calls = serve((method, path) => (method === "POST" && path === "/api/projects/p1/handovers" ? answer(201, created) : list(draft)(method, path)));
    render(<Handovers projectId="p1" myRole="WORKER" />);
    fireEvent.click(await screen.findByRole("button", { name: "Přidat předání" }));
    const dialog = await screen.findByRole("dialog", { name: "Protokol o předání staveniště" });

    fireEvent.change(within(dialog).getByLabelText("Typ předání"), { target: { value: "  Nový typ  " } });
    fireEvent.change(within(dialog).getByLabelText("Účastníci předání"), { target: { value: " Novák " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Přidat měřidlo" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Uložit předání" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ type: "Nový typ", participants: "Novák", meterStates: [], notes: null });
    expect(post.body).not.toHaveProperty("expectedUpdatedAt");
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles[0]).toBe("Nový typ");
  });

  it("sends a change with the version it was loaded in, and refuses text over the limit before it asks", async () => {
    const calls = serve((method, path) => (method === "PUT" ? answer(200, { ...draft, notes: "Opraveno", updatedAt: "2026-09-11T10:00:00Z" }) : list(draft)(method, path)));
    render(<Handovers projectId="p1" myRole="BOSS" />);
    fireEvent.click(await screen.findByRole("button", { name: "Upravit" }));
    const dialog = await screen.findByRole("dialog", { name: "Upravit protokol o předání staveniště" });
    expect((within(dialog).getByLabelText("Typ předání") as HTMLInputElement).value, "what is stored is in the form").toBe(draft.type);

    fireEvent.change(within(dialog).getByLabelText("Poznámky / Závěry"), { target: { value: "x".repeat(5001) } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Uložit předání" }));
    expect(await within(dialog).findByText(/nejvýše 5 000 znaků/)).toBeTruthy();
    expect(
      calls.filter((c) => c.method === "PUT"),
      "nothing was sent",
    ).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText("Poznámky / Závěry"), { target: { value: "Opraveno" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Uložit předání" }));
    await screen.findByText("Opraveno");
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ notes: "Opraveno", expectedUpdatedAt: draft.updatedAt });
  });

  it("says that the protocol was signed meanwhile when a change is refused with 409, and the typed text is not sent again", async () => {
    serve((method, path) => (method === "PUT" ? answer(409, { error: "Protokol už podepsala jedna ze stran, nelze jej měnit" }) : list(draft)(method, path)));
    render(<Handovers projectId="p1" myRole="BOSS" />);
    fireEvent.click(await screen.findByRole("button", { name: "Upravit" }));
    const dialog = await screen.findByRole("dialog", { name: "Upravit protokol o předání staveniště" });

    fireEvent.change(within(dialog).getByLabelText("Poznámky / Závěry"), { target: { value: "Opraveno" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Uložit předání" }));

    await screen.findByText(/Protokol už podepsala jedna ze stran/);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Načíst aktuální stav" })).toBeTruthy();
  });
});
