// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_EXPIRED_EVENT } from "../lib/api";
import { IDENTIFICATION_KEYS, type PartA, type SignPreview } from "../lib/signPreview";
import { SignEntryDialog } from "./SignEntryDialog";

/**
 * The sign dialog (backlog C2b): it shows part A of the diary before the password, sends the digest of what it showed, and when
 * the server says that something has changed it looks again and says what. The server decides everything (these tests make it say
 * what the real one says: `GET …/sign-preview` and `POST …/sign`); what is checked here is what the signer sees and what is sent.
 * The focus in a real browser is covered by e2e/signer-sees-part-a.spec.ts, the real `showModal` and a phone's width by e2e/mobile-pages.spec.ts.
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const PREVIEW = "/api/projects/p1/reports/2026-09-28/sign-preview";
const SIGN = "/api/projects/p1/reports/2026-09-28/sign";
const VERSION = "2026-09-28T08:00:00.123456Z";

const partA = (scopeOfBoss: string | null = "Celé dílo"): PartA => ({
  identification: {
    ...Object.fromEntries(IDENTIFICATION_KEYS.map((key) => [key, null])),
    name: "Bytový dům Zelená",
    address: "Zelená 1, Brno",
    contractor: "Zhotovitel s.r.o., Brno, IČO 2",
    permitDate: "2026-03-15",
    subcontractors: "Elektro s.r.o.\nVoda a.s.",
  },
  siteManager: { userId: "u1", name: "Jan Stavbyvedoucí", ckaitNumber: "0012345" },
  members: [
    { userId: "u1", name: "Jan Stavbyvedoucí", role: "BOSS", ckaitNumber: "0012345", scope: scopeOfBoss },
    { userId: "u3", name: "Ing. Dozor", role: "INSPECTOR", ckaitNumber: null, scope: "Technický dozor stavebníka" },
  ],
  authorizedPersons: [{ id: "a1", name: "Ing. Petr Černý", company: "Architekti s.r.o.", authorization: "Autorský dozor" }],
  projectId: "p1",
});

const preview = (digest: string, scope: string | null = "Celé dílo"): SignPreview => ({ partASha256: digest.padEnd(64, "0"), partA: partA(scope) });
const FIRST = preview("a1b2c3d4");
const SECOND = preview("99887766", "Jen přístavba");

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const NEWER = "2026-09-28T09:30:00.654321Z";

type Reply = Response | Error | Promise<Response>;

/**
 * The server as a script: every request is kept. One list answers the previews (GET …/sign-preview), one the signatures (POST …/sign)
 * and one the reads of the entry (GET of the entry itself, which the dialog does after a 409 to learn whether the entry changed); an
 * entry that is not scripted is unchanged (it has the version the dialog was opened with).
 */
function serve(previews: Reply[], signatures: Reply[] = [], entries: Reply[] = []) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const queues: Record<string, Reply[]> = { preview: [...previews], sign: [...signatures], entry: [...entries] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({ method, path, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
      const kind = method === "POST" ? "sign" : path.endsWith("/sign-preview") ? "preview" : "entry";
      const next = queues[kind].shift() ?? (kind === "entry" ? answer(200, { id: "e1", updatedAt: VERSION }) : undefined);
      if (next === undefined) throw new Error(`no answer scripted for ${method} ${path}`);
      if (next instanceof Error) throw next;
      return next;
    }),
  );
  return calls;
}

function renderDialog() {
  const handlers = { onCancel: vi.fn(), onSigned: vi.fn(), onEntryChanged: vi.fn() };
  render(<SignEntryDialog projectId="p1" reportId="2026-09-28" day="2026-09-28" updatedAt={VERSION} {...handlers} />);
  return handlers;
}

/**
 * The dialog on a page that does what the entry page does with the answers: it stops rendering the dialog when the dialog says it is
 * done (or cancelled), and shows what became of the entry. `page.dialogs()` counts the dialogs on the page, `page.state()` is what it shows.
 */
function renderPage() {
  const handlers = { onCancel: vi.fn(), onSigned: vi.fn(), onEntryChanged: vi.fn() };
  function Page() {
    const [open, setOpen] = useState(true);
    const [state, setState] = useState<"draft" | "signed" | "conflict">("draft");
    return (
      <>
        <p data-testid="state">{state}</p>
        {open && (
          <SignEntryDialog
            projectId="p1"
            reportId="2026-09-28"
            day="2026-09-28"
            updatedAt={VERSION}
            onCancel={() => {
              handlers.onCancel();
              setOpen(false);
            }}
            onSigned={() => {
              handlers.onSigned();
              setOpen(false);
              setState("signed");
            }}
            onEntryChanged={(message) => {
              handlers.onEntryChanged(message);
              setOpen(false);
              setState("conflict");
            }}
          />
        )}
      </>
    );
  }
  render(<Page />);
  const page = { dialogs: () => document.querySelectorAll("dialog").length, state: () => screen.getByTestId("state").textContent };
  return { ...handlers, page };
}

const partARegion = () => screen.findByRole("region", { name: /údaje o stavbě, které podepisujete/i });
const passwordField = () => screen.getByLabelText("Heslo") as HTMLInputElement;
const submitButton = () => screen.getByRole("button", { name: "Podepsat" }) as HTMLButtonElement;
const type = (value: string) => fireEvent.change(passwordField(), { target: { value } });
const submit = () => fireEvent.click(submitButton());

describe("what the signer sees before the password", () => {
  it("shows the identification, the persons with their scope, the authorised persons, and a short digest, above the password", async () => {
    serve([answer(200, FIRST)]);
    renderDialog();

    const region = await partARegion();
    await within(region).findByText("Bytový dům Zelená");
    const text = region.textContent ?? "";
    for (const expected of [
      "Název stavby",
      "Zelená 1, Brno",
      "Zhotovitel (název a sídlo, IČO)",
      "15. 3. 2026",
      "Elektro s.r.o.",
      "Hlavní stavbyvedoucí",
      "Jan Stavbyvedoucí",
      "ČKAIT 0012345",
      "Rozsah oprávnění a odpovědnosti",
      "Celé dílo",
      "Technický dozor stavebníka",
      "Ing. Petr Černý",
      "Architekti s.r.o.",
      "Autorský dozor",
    ]) {
      expect(text, expected).toContain(expected);
    }
    expect(text, "what the project does not say is said so").toContain("neuvedeno");

    expect(screen.getByText(/Otisk údajů o stavbě/).textContent).toContain("a1b2c3d4…");
    expect(screen.getByText(/stanou se součástí podpisu/)).toBeTruthy();
    // the block comes before the password field in the reading order
    expect(region.compareDocumentPosition(passwordField()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("announces that part A has arrived and tells the person to read it, while the focus stays on the block", async () => {
    let arrive: (response: Response) => void = () => {};
    serve([new Promise<Response>((resolve) => (arrive = resolve))]);
    renderDialog();

    const region = await partARegion();
    // The live region is there before there is anything to say (a region that appears with its text is not announced by every reader).
    const status = screen.getByRole("status");
    expect(status.textContent, "nothing is announced while part A is on its way").toBe("");
    const dialog = screen.getByRole("dialog");
    const description = document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
    expect(description, "the dialog says that part A is to be read before signing").toMatch(/přečtěte si údaje o stavbě/i);

    await act(async () => arrive(answer(200, FIRST)));
    await within(region).findByText("Bytový dům Zelená");
    expect(screen.getByRole("status").textContent).toBe("Údaje o stavbě jsou načteny; přečtěte si je před podpisem.");
    expect(document.activeElement, "and the focus is still on the block").toBe(region);
  });

  it("puts the focus on the block, not on the password: a phone's keyboard must not cover what is to be read", async () => {
    serve([answer(200, FIRST)]);
    renderDialog();

    const region = await partARegion();
    await within(region).findByText("Bytový dům Zelená");
    expect(document.activeElement).toBe(region);
    expect(region.getAttribute("tabindex"), "a scrolling block can be reached and scrolled from the keyboard").toBe("0");
  });

  it("does not let anyone sign before part A has arrived", async () => {
    let arrive: (response: Response) => void = () => {};
    serve([new Promise<Response>((resolve) => (arrive = resolve))]);
    renderDialog();

    const region = await partARegion();
    expect(region.getAttribute("aria-busy")).toBe("true");
    type("Password123!");
    expect(submitButton().disabled, "the button is off while part A is on its way").toBe(true);

    await act(async () => arrive(answer(200, FIRST)));
    await within(region).findByText("Bytový dům Zelená");
    expect(region.getAttribute("aria-busy")).toBe("false");
    expect(submitButton().disabled).toBe(false);
  });
});

describe("what is sent", () => {
  it("names the digest it showed, the version of the entry and the password, and says it is signed", async () => {
    const calls = serve([answer(200, FIRST)], [answer(200, { status: "ok" })]);
    const { onSigned, onEntryChanged } = renderDialog();
    await within(await partARegion()).findByText("Bytový dům Zelená");

    expect(submitButton().disabled, "no password yet").toBe(true);
    type("Password123!");
    submit();

    await waitFor(() => expect(onSigned).toHaveBeenCalledTimes(1));
    expect(onEntryChanged).not.toHaveBeenCalled();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${PREVIEW}`, `POST ${SIGN}`]);
    expect(calls[1].body).toEqual({ expectedUpdatedAt: VERSION, expectedPartASha256: FIRST.partASha256, password: "Password123!" });
  });

  it("keeps the dialog open and the part A on screen when the password is wrong, and says so at the password", async () => {
    const calls = serve([answer(200, FIRST)], [answer(400, { error: "Heslo není správné." })]);
    const { onSigned, onEntryChanged } = renderDialog();
    await within(await partARegion()).findByText("Bytový dům Zelená");

    type("Spatne-Heslo-1!");
    submit();

    const alert = await screen.findByText("Heslo není správné.");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(passwordField().getAttribute("aria-invalid")).toBe("true");
    expect(onSigned).not.toHaveBeenCalled();
    expect(onEntryChanged).not.toHaveBeenCalled();
    expect(
      calls.filter((c) => c.method === "GET"),
      "part A was not asked for again",
    ).toHaveLength(1);
    expect(screen.getByRole("region", { name: /údaje o stavbě/i }).textContent).toContain("Bytový dům Zelená");
    await waitFor(() => expect(submitButton().getAttribute("aria-disabled")).toBeNull());
  });
});

describe("when part A changed between the dialog and the click", () => {
  it("looks again, says that it changed and what, drops the password, and signs only what is shown now", async () => {
    const calls = serve(
      [answer(200, FIRST), answer(200, SECOND)],
      [answer(409, { error: "Údaje o stavbě, osoby nebo pověřené osoby se od zobrazení změnily.", code: "STALE_VERSION" }), answer(200, { status: "ok" })],
    );
    const { onSigned, onEntryChanged } = renderDialog();
    const region = await partARegion();
    await within(region).findByText(/Celé dílo/);

    type("Password123!");
    submit();

    // The new part A, a notice that says so and what changed, and the old scope is gone.
    await within(region).findByText(/Jen přístavba/);
    const notice = screen.getByText("Údaje o stavbě se mezi tím změnily; zkontrolujte je znovu.").closest("[role]")!;
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("Změna u osoby Jan Stavbyvedoucí: rozsah oprávnění a odpovědnosti");
    expect(region.textContent).not.toContain("Celé dílo");
    expect(screen.getByText(/Otisk údajů o stavbě/).textContent).toContain("99887766…");
    expect(onEntryChanged, "the entry itself did not change: the dialog stays").not.toHaveBeenCalled();
    expect(onSigned).not.toHaveBeenCalled();

    // The password is never kept, so the button is off until it is typed again, and the focus is on what is to be read again.
    expect(passwordField().value).toBe("");
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    expect(document.activeElement).toBe(region);

    type("Password123!");
    submit();
    await waitFor(() => expect(onSigned).toHaveBeenCalledTimes(1));
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((p) => p.body?.expectedPartASha256)).toEqual([FIRST.partASha256, SECOND.partASha256]);
  });

  const ENTRY_CHANGED = "Záznam se od načtení změnil. Načtěte jej znovu a zkontrolujte, co podepisujete.";
  const stale = (message: string) => answer(409, { error: message, code: "STALE_VERSION" });

  it("hands the entry back to the page when the entry is what changed (its version is another), and the dialog is gone", async () => {
    const calls = serve([answer(200, FIRST), answer(200, FIRST)], [stale(ENTRY_CHANGED)], [answer(200, { id: "e1", updatedAt: NEWER })]);
    const { onSigned, onEntryChanged, page } = renderPage();
    await within(await partARegion()).findByText(/Celé dílo/);

    type("Password123!");
    submit();

    await waitFor(() => expect(onEntryChanged).toHaveBeenCalledTimes(1));
    expect(onEntryChanged).toHaveBeenCalledWith(ENTRY_CHANGED);
    expect(onSigned).not.toHaveBeenCalled();
    expect(page.dialogs(), "the page took the dialog away").toBe(0);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("does not ask for the password a second time when the entry AND part A changed: the page gets the entry, the next dialog shows the new part A", async () => {
    const calls = serve([answer(200, FIRST), answer(200, SECOND)], [stale(ENTRY_CHANGED)], [answer(200, { id: "e1", updatedAt: NEWER })]);
    const { onSigned, onEntryChanged, page } = renderPage();
    await within(await partARegion()).findByText(/Celé dílo/);

    type("Password123!");
    submit();

    // Staying open with the old version of the entry would make the next attempt a certain second 409 and a second password.
    await waitFor(() => expect(onEntryChanged).toHaveBeenCalledWith(ENTRY_CHANGED));
    expect(page.dialogs()).toBe(0);
    expect(onSigned).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("hands the entry back too when the server refused and nothing at all differs (a change that was undone): the page loads it again", async () => {
    serve([answer(200, FIRST), answer(200, FIRST)], [stale(ENTRY_CHANGED)]);
    const { onEntryChanged } = renderPage();
    await within(await partARegion()).findByText(/Celé dílo/);

    type("Password123!");
    submit();

    await waitFor(() => expect(onEntryChanged).toHaveBeenCalledWith(ENTRY_CHANGED));
  });

  it("says neutrally that it could not check what changed when the second look at part A fails, and offers nothing to sign on", async () => {
    serve([answer(200, FIRST), answer(403, { error: "K podpisu záznamu je nutné číslo ČKAIT.", code: "SIGNER_NOT_QUALIFIED" })], [stale(ENTRY_CHANGED)]);
    const { onSigned, onEntryChanged } = renderDialog();
    const region = await partARegion();
    await within(region).findByText(/Celé dílo/);

    type("Password123!");
    submit();

    await within(region).findByText("K podpisu záznamu je nutné číslo ČKAIT.");
    const notice = screen.getByText("Nepodařilo se ověřit, co se změnilo; zavřete okno a otevřete ho znovu.").closest("[role]")!;
    expect(notice.getAttribute("role")).toBe("alert");
    // It does not claim that part A changed: the cause may be the entry.
    expect(screen.queryByText(/se mezi tím změnily/)).toBeNull();
    expect(passwordField().value).toBe("");
    type("Password123!");
    expect(submitButton().disabled, "nothing is signed on a part A that is not shown").toBe(true);
    expect(within(region).queryByRole("button", { name: "Načíst údaje o stavbě znovu" }), "and a retry would sign on a version of the entry that may be stale").toBeNull();
    expect(onSigned).not.toHaveBeenCalled();
    expect(onEntryChanged).not.toHaveBeenCalled();
  });

  it("says the same when it cannot read the entry to compare it (the network fails), also when part A could be read", async () => {
    serve([answer(200, FIRST), answer(200, SECOND)], [stale(ENTRY_CHANGED)], [new TypeError("Failed to fetch")]);
    const { onSigned, onEntryChanged } = renderDialog();
    await within(await partARegion()).findByText(/Celé dílo/);

    type("Password123!");
    submit();

    await screen.findByText("Nepodařilo se ověřit, co se změnilo; zavřete okno a otevřete ho znovu.");
    expect(screen.queryByText(/se mezi tím změnily/)).toBeNull();
    type("Password123!");
    expect(submitButton().disabled).toBe(true);
    expect(onSigned).not.toHaveBeenCalled();
    expect(onEntryChanged).not.toHaveBeenCalled();
  });
});

describe("an answer that comes after the dialog was closed (the server did not answer for 20 s and the person pressed Zavřít)", () => {
  /** The dialog on a page, a signature that is on its way, 20 s without an answer, and "Zavřít": the page has taken the dialog away. */
  async function closedWhileStalled() {
    let release: (response: Response | Error) => void = () => {};
    const late = new Promise<Response>((resolve, reject) => {
      release = (r) => (r instanceof Error ? reject(r) : resolve(r));
    });
    const calls = serve([answer(200, FIRST)], [late]);
    const view = renderPage();
    await within(await partARegion()).findByText(/Celé dílo/);
    type("Password123!");
    vi.useFakeTimers();
    submit();
    act(() => {
      vi.advanceTimersByTime(20_001);
    });
    fireEvent.click(screen.getByRole("button", { name: "Zavřít" }));
    expect(view.page.dialogs(), "the page took the dialog away").toBe(0);
    return { ...view, calls, release };
  }

  it("a late 200 still reaches the page: the entry is signed there, exactly once", async () => {
    const { onSigned, onEntryChanged, page, release } = await closedWhileStalled();
    expect(onSigned).not.toHaveBeenCalled();

    await act(async () => release(answer(200, { status: "ok" })));

    expect(onSigned).toHaveBeenCalledTimes(1);
    expect(onEntryChanged).not.toHaveBeenCalled();
    expect(page.state()).toBe("signed");
  });

  it("a late 409 still reaches the page, which says that the entry changed and loads it again", async () => {
    const { onSigned, onEntryChanged, page, release, calls } = await closedWhileStalled();

    await act(async () => release(answer(409, { error: "Záznam se od načtení změnil.", code: "STALE_VERSION" })));

    expect(onEntryChanged).toHaveBeenCalledTimes(1);
    expect(onEntryChanged).toHaveBeenCalledWith("Záznam se od načtení změnil.");
    expect(onSigned).not.toHaveBeenCalled();
    expect(page.state()).toBe("conflict");
    expect(
      calls.filter((c) => c.method === "GET"),
      "nothing is looked at again: there is no dialog to say it in",
    ).toHaveLength(1);
  });

  it("a late refusal (a wrong password, a network that fails) changes nothing and says nothing, and sets no state of the dialog that is gone", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const reply of [answer(400, { error: "Heslo není správné." }), new TypeError("Failed to fetch")]) {
        const { onSigned, onEntryChanged, page, release } = await closedWhileStalled();
        await act(async () => release(reply));
        expect(onSigned).not.toHaveBeenCalled();
        expect(onEntryChanged).not.toHaveBeenCalled();
        expect(page.state()).toBe("draft");
        cleanup();
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
      expect(errors, "no warning from React about an update of a component that is gone").not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe("when part A cannot be shown", () => {
  it("says why inside the block, does not offer to sign, and shows it when it is asked for again", async () => {
    const calls = serve([answer(403, { error: "K podpisu záznamu je nutné číslo ČKAIT. Požádejte administrátora.", code: "SIGNER_NOT_QUALIFIED" }), answer(200, FIRST)]);
    renderDialog();

    const region = await partARegion();
    const refusal = await within(region).findByText(/K podpisu záznamu je nutné číslo ČKAIT/);
    expect(refusal.getAttribute("role")).toBe("alert");
    type("Password123!");
    expect(submitButton().disabled).toBe(true);

    fireEvent.click(within(region).getByRole("button", { name: "Načíst údaje o stavbě znovu" }));
    await within(region).findByText("Bytový dům Zelená");
    expect(submitButton().disabled, "with part A shown and a password typed, the button is on").toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });

  it("raises the session dialog when the session has ended, and says so inside the block", async () => {
    const lapsed = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, lapsed);
    try {
      serve([answer(401, { error: "x" }), answer(200, FIRST)]);
      renderDialog();

      const region = await partARegion();
      await within(region).findByText(/Přihlášení vypršelo/);
      expect(lapsed).toHaveBeenCalledTimes(1);

      // After signing in again, the same button loads it.
      fireEvent.click(within(region).getByRole("button", { name: "Načíst údaje o stavbě znovu" }));
      await within(region).findByText("Bytový dům Zelená");
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, lapsed);
    }
  });

  it("does not draw a body that is not part A", async () => {
    serve([answer(200, { partA: null })]);
    renderDialog();

    const region = await partARegion();
    await within(region).findByText(/nepodařilo načíst/);
    expect(region.textContent).not.toContain("Název stavby");
    type("Password123!");
    expect(submitButton().disabled).toBe(true);
  });
});

describe("while the request is on its way, and when the session ends", () => {
  it("cannot be dismissed while the server answers, and says that the server is silent when it does not", async () => {
    serve([answer(200, FIRST)], [new Promise<Response>(() => {})]);
    const { onCancel } = renderDialog();
    await within(await partARegion()).findByText(/Celé dílo/);
    type("Password123!");

    vi.useFakeTimers();
    submit();
    const dialog = screen.getByRole("dialog");
    const escape = new Event("cancel", { cancelable: true });
    act(() => {
      dialog.dispatchEvent(escape);
    });
    expect(escape.defaultPrevented, "Escape does not close it").toBe(true);
    expect(onCancel, "and does not cancel").not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Zrušit" }).getAttribute("aria-disabled")).toBe("true");

    act(() => {
      vi.advanceTimersByTime(20_001);
    });
    expect(screen.getByText("Server neodpovídá.")).toBeTruthy();
    expect(screen.getByText(/Nevíme, jestli se záznam podepsal/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Zavřít" }));
    expect(onCancel, "now it can be closed").toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog and the typed password when the session ended at the click, so the same button works after signing in again", async () => {
    const lapsed = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, lapsed);
    try {
      serve([answer(200, FIRST)], [answer(401, { error: "x" }), answer(200, { status: "ok" })]);
      const { onSigned } = renderDialog();
      await within(await partARegion()).findByText(/Celé dílo/);

      type("Password123!");
      submit();
      await screen.findByText(/Přihlášení vypršelo/);
      expect(lapsed).toHaveBeenCalledTimes(1);
      expect(passwordField().value, "a lapsed session says nothing about the password").toBe("Password123!");

      await waitFor(() => expect(submitButton().getAttribute("aria-disabled")).toBeNull());
      submit();
      await waitFor(() => expect(onSigned).toHaveBeenCalledTimes(1));
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, lapsed);
    }
  });

  it("says in the dialog that the request did not get through, and the button is on again", async () => {
    serve([answer(200, FIRST)], [new TypeError("Failed to fetch")]);
    const { onSigned } = renderDialog();
    await within(await partARegion()).findByText(/Celé dílo/);

    type("Password123!");
    submit();

    await screen.findByText(/Failed to fetch|nepodařilo/);
    await waitFor(() => expect(submitButton().getAttribute("aria-disabled")).toBeNull());
    expect(onSigned).not.toHaveBeenCalled();
  });
});
