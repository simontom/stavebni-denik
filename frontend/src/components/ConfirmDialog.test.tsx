// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, discardUnsavedWork, hasUnsavedWork, unsavedWorkMessage } from "../lib/api";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * The question that replaces `window.confirm`: a modal dialog with the verb on the confirm button, the safe answer in focus, and,
 * when the answer is an action that can fail, a dialog that stays open while it runs and says inside itself what went wrong.
 * (The real focus, the backdrop and the real server are covered by e2e/dialogs.spec.ts.)
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

afterEach(() => {
  cleanup();
  discardUnsavedWork();
});

function pressEscape(dialog: HTMLElement) {
  act(() => {
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  });
}

const dialog = () => screen.getByRole("dialog", { name: "Smazat uživatele?" }) as HTMLDialogElement;

/** A page that asks and stops rendering the question once it is answered (as every page must). */
function Page({ children }: { children: (done: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button>opener</button>
      {open && children(() => setOpen(false))}
    </>
  );
}

describe("a question with a verb on its button", () => {
  it("is named by its title, described by its question, and the safe answer has the focus", () => {
    render(
      <Page>
        {(done) => (
          <ConfirmDialog title="Smazat uživatele?" confirmLabel="Smazat" cancelLabel="Zrušit" onCancel={done} onConfirm={done}>
            Uživatel novak se už nebude moci přihlásit.
          </ConfirmDialog>
        )}
      </Page>,
    );
    const d = dialog();
    const described = d.getAttribute("aria-describedby")!;
    expect(d.ownerDocument.getElementById(described)!.textContent).toBe("Uživatel novak se už nebude moci přihlásit.");
    expect(document.activeElement).toBe(within(d).getByRole("button", { name: "Zrušit" }));
  });

  it("closes first and then does what was asked, when the answer is yes (no action that can fail)", () => {
    let openWhenAsked: boolean | null = null;
    let element: HTMLDialogElement | null = null;
    const onConfirm = vi.fn(() => {
      openWhenAsked = element!.open;
    });
    render(
      <Page>
        {(done) => (
          <ConfirmDialog
            title="Smazat uživatele?"
            confirmLabel="Smazat"
            cancelLabel="Zrušit"
            onCancel={done}
            onConfirm={() => {
              onConfirm();
              done();
            }}
          >
            Otázka
          </ConfirmDialog>
        )}
      </Page>,
    );
    element = dialog() as HTMLDialogElement;
    fireEvent.click(within(element).getByRole("button", { name: "Smazat" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(openWhenAsked, "the dialog was closed before the page reacted").toBe(false);
  });

  /** A page whose button asks the question: the focus is on that button when the question opens, and has to be back on it when it is answered "no". */
  function Asking({ onCancel }: { onCancel: () => void }) {
    const [open, setOpen] = useState(false);
    const no = () => {
      onCancel();
      setOpen(false);
    };
    return (
      <>
        <button onClick={() => setOpen(true)}>smazat</button>
        {open && (
          <ConfirmDialog title="Smazat uživatele?" confirmLabel="Smazat" cancelLabel="Zrušit" onCancel={no} onConfirm={no}>
            Otázka
          </ConfirmDialog>
        )}
      </>
    );
  }
  const askFrom = (button: HTMLElement) => {
    button.focus();
    fireEvent.click(button);
  };

  it("is a no on Escape, and the focus goes back to the button that asked", () => {
    const onCancel = vi.fn();
    render(<Asking onCancel={onCancel} />);
    const opener = screen.getByText("smazat");
    askFrom(opener);
    expect(document.activeElement, "the safe answer is in focus").toBe(within(dialog()).getByRole("button", { name: "Zrušit" }));
    pressEscape(dialog());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("is a no on the safe button, and the focus goes back to the button that asked", () => {
    const onCancel = vi.fn();
    render(<Asking onCancel={onCancel} />);
    const opener = screen.getByText("smazat");
    askFrom(opener);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Zrušit" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("an answer that is an action that can fail", () => {
  const ask = (action: () => Promise<string>, onDone: (result: string) => void, onCancel = vi.fn(), extra: { leaveMessage?: string; stalledNote?: string } = {}) =>
    render(
      <Page>
        {(done) => (
          <ConfirmDialog
            title="Smazat uživatele?"
            confirmLabel="Smazat"
            cancelLabel="Zrušit"
            {...extra}
            action={action}
            onDone={(result) => {
              onDone(result);
              done();
            }}
            onCancel={() => {
              onCancel();
              done();
            }}
          >
            Otázka
          </ConfirmDialog>
        )}
      </Page>,
    );

  it("stays open and cannot be dismissed while it runs, then closes and hands over the result", async () => {
    let finish!: (value: string) => void;
    const onDone = vi.fn();
    const onCancel = vi.fn();
    ask(() => new Promise<string>((resolve) => (finish = resolve)), onDone, onCancel);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Smazat" }));

    expect(dialog().open).toBe(true);
    // Off for the person (aria-disabled, and a click does nothing) but not `disabled`: a disabled button that has the focus loses it
    for (const name of ["Zrušit", "Smazat"]) {
      const button = within(dialog()).getByRole("button", { name }) as HTMLButtonElement;
      expect(button.getAttribute("aria-disabled"), `"${name}" is off while it runs`).toBe("true");
      expect(button.disabled, `"${name}" keeps its place in the Tab order and the focus`).toBe(false);
    }
    fireEvent.click(within(dialog()).getByRole("button", { name: "Zrušit" }));
    pressEscape(dialog());
    expect(onCancel, "neither Escape nor the button answers while it runs").not.toHaveBeenCalled();
    expect(dialog().open).toBe(true);

    await act(async () => finish("hotovo"));
    expect(onDone).toHaveBeenCalledWith("hotovo");
    expect(screen.queryByRole("dialog"), "answered: not rendered any more").toBeNull();
  });

  it("says what went wrong inside the dialog, which stays open, and the same answer can be tried again", async () => {
    const action = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new ApiError(409, "Nelze smazat uživatele, je stavbyvedoucím projektu X.")).mockResolvedValueOnce("ok");
    const onDone = vi.fn();
    ask(action, onDone);

    fireEvent.click(within(dialog()).getByRole("button", { name: "Smazat" }));
    const alert = await within(dialog()).findByRole("alert");
    expect(alert.textContent).toContain("je stavbyvedoucím projektu X");
    expect(dialog().open).toBe(true);
    expect(onDone).not.toHaveBeenCalled();
    expect(within(dialog()).getByRole("button", { name: "Zrušit" }).getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(within(dialog()).getByRole("button", { name: "Smazat" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("ok"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the focus on the button that was pressed when the action is refused, so the same key can be pressed again", async () => {
    const action = vi.fn<() => Promise<string>>().mockRejectedValue(new ApiError(409, "Nelze smazat."));
    ask(action, vi.fn());
    const yes = within(dialog()).getByRole("button", { name: "Smazat" });
    yes.focus();
    fireEvent.click(yes);
    await within(dialog()).findByRole("alert");
    expect(document.activeElement, "the focus is not lost to the page when the buttons are on again").toBe(yes);
    fireEvent.click(yes);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
  });

  it("counts as unsaved work while it runs, and says what leaving loses", async () => {
    let finish!: (value: string) => void;
    ask(() => new Promise<string>((resolve) => (finish = resolve)), vi.fn(), vi.fn(), { leaveMessage: "Heslo se právě mění; když odejdete, nové heslo se nezobrazí." });
    expect(hasUnsavedWork(), "nothing runs before the answer").toBe(false);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Smazat" }));
    expect(hasUnsavedWork()).toBe(true);
    expect(unsavedWorkMessage()).toBe("Heslo se právě mění; když odejdete, nové heslo se nezobrazí.");
    await act(async () => finish("hotovo"));
    expect(hasUnsavedWork(), "done").toBe(false);
  });

  it("has words of its own for what leaving loses when the page gave none", () => {
    ask(() => new Promise<string>(() => undefined), vi.fn());
    fireEvent.click(within(dialog()).getByRole("button", { name: "Smazat" }));
    expect(unsavedWorkMessage()).toMatch(/právě se provádí/i);
  });

  it("can still be cancelled after a failure, and Escape is a no again", async () => {
    const onCancel = vi.fn();
    ask(() => Promise.reject(new Error("Chyba serveru")), vi.fn(), onCancel);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Smazat" }));
    await within(dialog()).findByRole("alert");
    pressEscape(dialog());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a server that does not answer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const wait = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  function Asking({ action, onDone, onCancel, stalledNote }: { action: () => Promise<string>; onDone: (r: string) => void; onCancel: () => void; stalledNote?: string }) {
    const [open, setOpen] = useState(true);
    return open ? (
      <ConfirmDialog
        title="Smazat uživatele?"
        confirmLabel="Smazat"
        cancelLabel="Zrušit"
        stalledNote={stalledNote}
        action={action}
        onDone={(r) => {
          onDone(r);
          setOpen(false);
        }}
        onCancel={() => {
          onCancel();
          setOpen(false);
        }}
      >
        Otázka
      </ConfirmDialog>
    ) : null;
  }

  it("is waited for for a while, and then the dialog says so and can be closed, without claiming that the action failed or went through", async () => {
    const onCancel = vi.fn();
    const onDone = vi.fn();
    render(<Asking action={() => new Promise<string>(() => undefined)} onDone={onDone} onCancel={onCancel} stalledNote="Heslo se mohlo změnit, nebo ne." />);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Smazat" }));

    await wait(19_000);
    expect(screen.queryByText(/Server neodpovídá/), "not yet").toBeNull();
    pressEscape(dialog());
    expect(onCancel, "no way out in the first seconds").not.toHaveBeenCalled();

    await wait(2_000);
    expect(screen.getByText(/Server neodpovídá/).closest("[role=status]")!.textContent).toContain("Heslo se mohlo změnit, nebo ne.");
    expect(screen.queryByRole("alert"), "it is not said to have failed").toBeNull();
    const close = within(dialog()).getByRole("button", { name: "Zavřít" });
    expect(close.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(close);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDone, "nor to have succeeded").not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("can be left with Escape once it has said so", async () => {
    const onCancel = vi.fn();
    render(<Asking action={() => new Promise<string>(() => undefined)} onDone={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Smazat" }));
    await wait(21_000);
    expect(screen.getByText(/Server neodpovídá/).closest("[role=status]")!.textContent).toMatch(/Nevíme, jestli se akce provedla/);
    pressEscape(dialog());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not wait for an answer that came in time", async () => {
    let finish!: (value: string) => void;
    const onDone = vi.fn();
    render(<Asking action={() => new Promise<string>((resolve) => (finish = resolve))} onDone={onDone} onCancel={vi.fn()} />);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Smazat" }));
    await wait(5_000);
    await act(async () => finish("ok"));
    expect(onDone).toHaveBeenCalledWith("ok");
    await wait(30_000);
    expect(screen.queryByText(/Server neodpovídá/)).toBeNull();
  });
});
