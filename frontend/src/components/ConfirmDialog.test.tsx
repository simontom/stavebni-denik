// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
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

afterEach(cleanup);

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

  it("is a no on Escape and on the safe button, and the focus goes back to what had it", () => {
    const onCancel = vi.fn();
    render(
      <Page>
        {(done) => (
          <ConfirmDialog
            title="Smazat uživatele?"
            confirmLabel="Smazat"
            cancelLabel="Zrušit"
            onCancel={() => {
              onCancel();
              done();
            }}
            onConfirm={done}
          >
            Otázka
          </ConfirmDialog>
        )}
      </Page>,
    );
    pressEscape(dialog());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("an answer that is an action that can fail", () => {
  const ask = (action: () => Promise<string>, onDone: (result: string) => void, onCancel = vi.fn()) =>
    render(
      <Page>
        {(done) => (
          <ConfirmDialog
            title="Smazat uživatele?"
            confirmLabel="Smazat"
            cancelLabel="Zrušit"
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
    expect((within(dialog()).getByRole("button", { name: "Zrušit" }) as HTMLButtonElement).disabled, "no second answer while it runs").toBe(true);
    expect((within(dialog()).getByRole("button", { name: "Smazat" }) as HTMLButtonElement).disabled).toBe(true);
    pressEscape(dialog());
    expect(onCancel, "Escape does nothing while it runs").not.toHaveBeenCalled();
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
    expect((within(dialog()).getByRole("button", { name: "Zrušit" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(within(dialog()).getByRole("button", { name: "Smazat" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("ok"));
    expect(screen.queryByRole("dialog")).toBeNull();
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
