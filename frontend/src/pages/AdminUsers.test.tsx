// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminUsers } from "./AdminUsers";

/**
 * The users page: every question is a dialog of the application's own (never `window.confirm`), a temporary password is shown once and
 * is nowhere in the page afterwards, and what the server refuses is said inside the dialog that asked. The real browser (focus, the
 * backdrop, a session that ends) and the real server are e2e/dialogs.spec.ts.
 *
 * jsdom has `<dialog>` but not `showModal()` or `close()`: the few lines below give it the part of their behaviour that matters here.
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

const novak = { id: "u1", nickname: "novak", displayName: "Jan Novák", role: "WORKER", isAdmin: false, isActive: true, ckaitNumber: null };
const me = { id: "me", nickname: "admin", displayName: "Admin", role: "BOSS", isAdmin: true, isActive: true, ckaitNumber: "0000000" };
const PASSWORD = "Prvni-Dockasne-Heslo-77!";

function answer(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The server as a script; every request is kept. */
function serve(reply: (method: string, path: string, body: unknown) => Response | undefined) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      return reply(method, path, body) ?? (method === "GET" && path === "/api/users" ? answer(200, [me, novak]) : answer(404, { error: "?" }));
    }),
  );
  return calls;
}

let confirm: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  localStorage.setItem("user", JSON.stringify({ id: "me", nickname: "admin", displayName: "Admin", role: "BOSS", isAdmin: true }));
  confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const rowOf = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;
const pressEscape = (dialog: HTMLElement) =>
  act(() => {
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  });

describe("the temporary password of a new account", () => {
  it("is shown in a dialog that cannot be dismissed until it is handed over, and is nowhere in the page afterwards", async () => {
    serve((method, path) =>
      method === "POST" && path === "/api/users"
        ? answer(201, { user: { ...novak, id: "u2", nickname: "svoboda", displayName: "Petr Svoboda" }, initialPassword: PASSWORD })
        : undefined,
    );
    render(<AdminUsers />);
    await screen.findByText("Jan Novák");

    fireEvent.click(screen.getByRole("button", { name: "Nový uživatel" }));
    const form = await screen.findByRole("dialog", { name: "Vytvořit nového uživatele" });
    fireEvent.change(within(form).getByLabelText("Přihlašovací jméno (nickname)"), { target: { value: "svoboda" } });
    fireEvent.change(within(form).getByLabelText("Jméno a příjmení (displayName)"), { target: { value: "Petr Svoboda" } });
    fireEvent.submit(form.querySelector("form")!);

    const shown = await screen.findByRole("dialog", { name: "Uživatel byl vytvořen" });
    expect(screen.queryByRole("dialog", { name: "Vytvořit nového uživatele" }), "the form is gone").toBeNull();
    expect(within(shown).getByTestId("one-time-password").textContent).toBe(PASSWORD);

    // not before it is handed over
    pressEscape(shown);
    expect((within(shown).getByRole("button", { name: "Hotovo" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Uživatel byl vytvořen" })).not.toBeNull();

    fireEvent.click(within(shown).getByLabelText("Heslo jsem předal(a)"));
    fireEvent.click(within(shown).getByRole("button", { name: "Hotovo" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent, "the password is not in the page any more").not.toContain(PASSWORD);
    expect(screen.getByText("Petr Svoboda"), "the new account is in the list").toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("is asked about before a form with typed text is closed, and the answer 'write on' keeps it", async () => {
    serve(() => undefined);
    render(<AdminUsers />);
    await screen.findByText("Jan Novák");
    fireEvent.click(screen.getByRole("button", { name: "Nový uživatel" }));
    const form = await screen.findByRole("dialog", { name: "Vytvořit nového uživatele" });
    fireEvent.change(within(form).getByLabelText("Přihlašovací jméno (nickname)"), { target: { value: "rozepsane" } });

    pressEscape(form);
    const ask = await screen.findByRole("dialog", { name: "Zahodit rozepsané?" });
    fireEvent.click(within(ask).getByRole("button", { name: "Psát dál" }));
    expect((within(form).getByLabelText("Přihlašovací jméno (nickname)") as HTMLInputElement).value).toBe("rozepsane");

    fireEvent.click(within(form).getByRole("button", { name: "Zrušit" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Zahodit rozepsané?" })).getByRole("button", { name: "Zahodit" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("what the server refuses", () => {
  it("is said inside the edit dialog, which stays open with the typed text, and not on the page behind it", async () => {
    serve((method, path) => (method === "PATCH" && path === "/api/users/u1" ? answer(400, { error: "Jméno a příjmení může mít nejvýše 200 znaků" }) : undefined));
    render(<AdminUsers />);
    await screen.findByText("Jan Novák");
    fireEvent.click(within(rowOf("novak")).getByRole("button", { name: "Upravit" }));
    const edit = await screen.findByRole("dialog", { name: "Upravit uživatele" });
    fireEvent.change(within(edit).getByLabelText("Jméno a příjmení"), { target: { value: "x".repeat(201) } });
    fireEvent.submit(edit.querySelector("form")!);

    const alert = await within(edit).findByRole("alert");
    expect(alert.textContent).toContain("nejvýše 200 znaků");
    expect((within(edit).getByLabelText("Jméno a příjmení") as HTMLInputElement).value).toBe("x".repeat(201));
    expect(
      screen.queryAllByRole("alert").filter((a) => !edit.contains(a)),
      "nothing on the page behind the dialog",
    ).toEqual([]);
    expect((within(edit).getByRole("button", { name: "Uložit změny" }) as HTMLButtonElement).disabled, "the person can try again").toBe(false);
  });

  it("is said inside the question that asked, which stays open, and an account cannot be deleted without the question", async () => {
    serve((method, path) => (method === "DELETE" && path === "/api/users/u1" ? answer(409, { error: "Uživatel je stavbyvedoucím projektu Dům U Lípy." }) : undefined));
    render(<AdminUsers />);
    await screen.findByText("Jan Novák");
    fireEvent.click(within(rowOf("novak")).getByRole("button", { name: "Smazat" }));

    const ask = await screen.findByRole("dialog", { name: "Smazat uživatele?" });
    expect(within(ask).getByText(/novak/)).toBeTruthy();
    expect(document.activeElement, "the safe answer is in focus").toBe(within(ask).getByRole("button", { name: "Zrušit" }));
    fireEvent.click(within(ask).getByRole("button", { name: "Smazat" }));

    expect((await within(ask).findByRole("alert")).textContent).toContain("stavbyvedoucím projektu");
    expect(screen.getByText("Jan Novák"), "nothing was deleted").toBeTruthy();
    fireEvent.click(within(ask).getByRole("button", { name: "Zrušit" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("a question that is answered yes", () => {
  it("deletes the account and takes the question off the page", async () => {
    const calls = serve((method, path) => (method === "DELETE" && path === "/api/users/u1" ? answer(204, undefined) : undefined));
    render(<AdminUsers />);
    await screen.findByText("Jan Novák");
    fireEvent.click(within(rowOf("novak")).getByRole("button", { name: "Smazat" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Smazat uživatele?" })).getByRole("button", { name: "Smazat" }));
    await waitFor(() => expect(screen.queryByText("Jan Novák")).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/users/u1")).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("resets a password only after the question, and shows the new one once", async () => {
    const calls = serve((method, path) => (method === "POST" && path === "/api/users/u1/reset-password" ? answer(200, { initialPassword: PASSWORD }) : undefined));
    render(<AdminUsers />);
    await screen.findByText("Jan Novák");
    fireEvent.click(within(rowOf("novak")).getByRole("button", { name: "Obnovit heslo" }));
    const ask = await screen.findByRole("dialog", { name: "Obnovit heslo?" });
    expect(
      calls.filter((c) => c.method === "POST"),
      "nothing is sent before the answer",
    ).toHaveLength(0);
    fireEvent.click(within(ask).getByRole("button", { name: "Obnovit heslo" }));

    const shown = await screen.findByRole("dialog", { name: "Heslo bylo obnoveno" });
    expect(screen.queryByRole("dialog", { name: "Obnovit heslo?" })).toBeNull();
    expect(within(shown).getByTestId("one-time-password").textContent).toBe(PASSWORD);
    fireEvent.click(within(shown).getByLabelText("Heslo jsem předal(a)"));
    pressEscape(shown);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(PASSWORD);
  });
});
