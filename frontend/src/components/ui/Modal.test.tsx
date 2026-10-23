// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";
import { useModal } from "./modalContext";

/**
 * The behaviour of the shared Modal that does not need a real browser: what Escape does, the scroll lock, what the dialog is
 * described by, and that a dialog nobody asked to close stays open. (Focus, the backdrop and the real `showModal` are covered by
 * the Playwright suite: e2e/report-navigation.spec.ts and e2e/ui-foundations.spec.ts.)
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
    // Like a browser: the event comes later, as a task of its own.
    setTimeout(() => this.dispatchEvent(new Event("close")), 0);
  };
});

afterEach(() => {
  cleanup();
  document.documentElement.className = "";
});

/** Escape: the browser fires `cancel` at the dialog, and closes it unless the event is cancelled. Returns whether it was cancelled. */
function pressEscape(dialog: HTMLElement): boolean {
  const event = new Event("cancel", { cancelable: true });
  // in act(): what the page does with the answer (a question opens, a dialog is taken away) is drawn before the next line looks
  act(() => {
    dialog.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

const dialogOf = (container: HTMLElement) => container.querySelector("dialog") as HTMLDialogElement;

describe("Escape", () => {
  it("is passed to onCancel, and the dialog closes (the page unmounts it)", () => {
    const onCancel = vi.fn();
    const { container } = render(
      <Modal title="Otázka" onCancel={onCancel}>
        text
      </Modal>,
    );
    const dialog = dialogOf(container);
    expect(dialog.open).toBe(true);
    // The browser must not close it by itself (that would leave a closed dialog that is still mounted): the Modal does.
    expect(pressEscape(dialog)).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(false);
  });

  it("is refused while the dialog is not dismissible, and nothing happens", () => {
    const onCancel = vi.fn();
    const { container } = render(
      <Modal title="Ukládám" onCancel={onCancel} dismissible={false}>
        text
      </Modal>,
    );
    const dialog = dialogOf(container);
    expect(pressEscape(dialog)).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
  });

  it("is refused when onCancel says no, and the dialog stays open", () => {
    const onCancel = vi.fn(() => false);
    const { container } = render(
      <Modal title="Heslo" onCancel={onCancel}>
        text
      </Modal>,
    );
    const dialog = dialogOf(container);
    expect(pressEscape(dialog)).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(true);
    // ...and a second Escape is asked again
    pressEscape(dialog);
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(dialog.open).toBe(true);
  });

  it("can be refused for a while and accepted later", () => {
    function Page() {
      const [saving, setSaving] = useState(true);
      return (
        <>
          <button onClick={() => setSaving(false)}>done</button>
          <Modal title="Ukládám" onCancel={() => undefined} dismissible={!saving}>
            text
          </Modal>
        </>
      );
    }
    const { container } = render(<Page />);
    const dialog = dialogOf(container);
    pressEscape(dialog);
    expect(dialog.open).toBe(true);
    fireEvent.click(screen.getByText("done"));
    pressEscape(dialog);
    expect(dialog.open).toBe(false);
  });

  it("puts the focus back on what had it before the dialog opened", () => {
    function Page() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>opener</button>
          {open && (
            <Modal title="Otázka" onCancel={() => setOpen(false)}>
              text
            </Modal>
          )}
        </>
      );
    }
    const { container } = render(<Page />);
    const opener = screen.getByText("opener");
    opener.focus();
    fireEvent.click(opener);
    const dialog = dialogOf(container);
    expect(dialog.open).toBe(true);
    // the dialog is closed BEFORE React takes it out of the document, and the focus is back on the opener
    let openAtRemoval: boolean | null = null;
    const removeChild = container.removeChild.bind(container);
    container.removeChild = ((child: Node) => {
      if (child === dialog) openAtRemoval = dialog.open;
      return removeChild(child);
    }) as typeof container.removeChild;
    act(() => {
      pressEscape(dialog);
    });
    expect(dialogOf(container)).toBeNull();
    expect(openAtRemoval).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("a button inside it can close it first and then do its work", () => {
    const after = vi.fn();
    function Answer() {
      const modal = useModal();
      return <button onClick={() => modal.close(after)}>ok</button>;
    }
    const { container } = render(
      <Modal title="Otázka" onCancel={() => undefined} footer={<Answer />}>
        text
      </Modal>,
    );
    const dialog = dialogOf(container);
    fireEvent.click(screen.getByText("ok"));
    expect(dialog.open).toBe(false);
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe("the focus after an answer that changes the page", () => {
  /** A page whose button asks, and whose answer ("yes") removes that very button: a deleted row, an acknowledgement that is written. */
  function Yes({ answer, fallback }: { answer: () => void; fallback?: () => HTMLElement | null }) {
    const modal = useModal();
    return <button onClick={() => modal.close(answer, { restoreFocus: true, fallback })}>Ano</button>;
  }
  function Page({ heading = true, fallback, afterYes }: { heading?: boolean; fallback?: () => HTMLElement | null; afterYes?: () => void }) {
    const [row, setRow] = useState(true);
    const [asking, setAsking] = useState(false);
    const answer = () => {
      setRow(false);
      setAsking(false);
      afterYes?.();
    };
    return (
      <main>
        {heading && <h1>Seznam</h1>}
        <button id="other">jiné</button>
        {row && <button onClick={() => setAsking(true)}>smazat</button>}
        {asking && (
          <Modal title="Smazat?" onCancel={() => setAsking(false)} footer={<Yes answer={answer} fallback={fallback} />}>
            text
          </Modal>
        )}
      </main>
    );
  }

  const ask = () => {
    const opener = screen.getByText("smazat");
    opener.focus();
    fireEvent.click(opener);
  };

  it("is on the heading of the page when the button that asked is gone with the answer", () => {
    render(<Page />);
    ask();
    fireEvent.click(screen.getByText("Ano"));
    expect(screen.queryByText("smazat"), "the button is gone").toBeNull();
    expect(document.activeElement, "the focus is not lost to the top of the document").toBe(screen.getByRole("heading", { name: "Seznam" }));
  });

  it("is on the page itself when it has no heading", () => {
    render(<Page heading={false} />);
    ask();
    fireEvent.click(screen.getByText("Ano"));
    expect(document.activeElement).toBe(document.querySelector("main"));
  });

  it("is on the place the page names when it names one, before the heading", () => {
    render(<Page fallback={() => document.getElementById("other")} />);
    ask();
    fireEvent.click(screen.getByText("Ano"));
    expect(document.activeElement).toBe(document.getElementById("other"));
  });

  it("is left alone when the page itself put it somewhere, and is on the button that asked when that is still there", () => {
    render(<Page afterYes={() => document.getElementById("other")?.focus()} />);
    ask();
    fireEvent.click(screen.getByText("Ano"));
    expect(document.activeElement, "the page's own choice").toBe(document.getElementById("other"));
    cleanup();

    function Stays() {
      const [asking, setAsking] = useState(false);
      return (
        <main>
          <h1>Seznam</h1>
          <button onClick={() => setAsking(true)}>zeptat se</button>
          {asking && (
            <Modal title="Otázka" onCancel={() => setAsking(false)}>
              text
            </Modal>
          )}
        </main>
      );
    }
    render(<Stays />);
    const opener = screen.getByText("zeptat se");
    opener.focus();
    fireEvent.click(opener);
    pressEscape(screen.getByRole("dialog", { name: "Otázka" }));
    expect(document.activeElement).toBe(opener);
  });
});

describe("a dialog that holds typed text (unsaved)", () => {
  const question = () => screen.queryByRole("dialog", { name: "Zahodit rozepsané?" });

  /** A form dialog with a field and a "Zrušit" button that cancels the way a person does. */
  function Form({ unsaved = true, dismissible = true, onCancel }: { unsaved?: boolean; dismissible?: boolean; onCancel: () => void }) {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button>opener</button>
        {open && (
          <Modal
            title="Upravit"
            unsaved={unsaved}
            dismissible={dismissible}
            onCancel={() => {
              onCancel();
              setOpen(false);
            }}
            footer={<Cancel />}
          >
            <input aria-label="Jméno" />
          </Modal>
        )}
      </>
    );
  }
  function Cancel() {
    const modal = useModal();
    return <button onClick={() => modal.cancel()}>Zrušit</button>;
  }
  const formDialog = () => screen.getByRole("dialog", { name: "Upravit" }) as HTMLDialogElement;

  it("asks before Escape throws the text away, and does nothing else yet", () => {
    const onCancel = vi.fn();
    render(<Form onCancel={onCancel} />);
    const dialog = formDialog();
    expect(pressEscape(dialog)).toBe(true);
    expect(question(), "the question is open").not.toBeNull();
    expect(onCancel, "nothing was cancelled").not.toHaveBeenCalled();
    expect(dialog.open, "the dialog is still open under the question").toBe(true);
  });

  it("asks before the Zrušit button throws the text away", () => {
    const onCancel = vi.fn();
    render(<Form onCancel={onCancel} />);
    fireEvent.click(within(formDialog()).getByText("Zrušit"));
    expect(question()).not.toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps the text when the person writes on (the button, and Escape on the question), and the question is gone at once", () => {
    const onCancel = vi.fn();
    render(<Form onCancel={onCancel} />);
    pressEscape(formDialog());
    fireEvent.click(within(question()!).getByText("Psát dál"));
    expect(question(), "answered: not rendered any more").toBeNull();
    expect(formDialog().open).toBe(true);

    pressEscape(formDialog());
    expect(question()).not.toBeNull();
    pressEscape(question()!);
    expect(question()).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    expect(formDialog().open).toBe(true);
  });

  it("throws the text away only when the person says so, and then the page is told to cancel", () => {
    const onCancel = vi.fn();
    render(<Form onCancel={onCancel} />);
    pressEscape(formDialog());
    fireEvent.click(within(question()!).getByText("Zahodit"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Upravit" }), "the page stopped rendering the dialog").toBeNull();
    expect(question()).toBeNull();
  });

  it("puts the focus back on the opener after the text was thrown away", () => {
    function Page() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>opener</button>
          {open && (
            <Modal title="Upravit" unsaved onCancel={() => setOpen(false)}>
              <input aria-label="Jméno" />
            </Modal>
          )}
        </>
      );
    }
    render(<Page />);
    const button = screen.getByText("opener");
    button.focus();
    fireEvent.click(button);
    pressEscape(formDialog());
    act(() => {
      fireEvent.click(within(question()!).getByText("Zahodit"));
    });
    expect(screen.queryByRole("dialog", { name: "Upravit" })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("closes at once, without a question, when nothing is typed", () => {
    const onCancel = vi.fn();
    render(<Form unsaved={false} onCancel={onCancel} />);
    pressEscape(formDialog());
    expect(question()).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not ask, and does nothing, while the dialog cannot be dismissed (it is saving)", () => {
    const onCancel = vi.fn();
    render(<Form dismissible={false} onCancel={onCancel} />);
    pressEscape(formDialog());
    fireEvent.click(within(formDialog()).getByText("Zrušit"));
    expect(question()).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    expect(formDialog().open).toBe(true);
  });

  it("asks again for the next Escape, and the safe answer has the focus", () => {
    render(<Form onCancel={vi.fn()} />);
    pressEscape(formDialog());
    expect(document.activeElement).toBe(within(question()!).getByText("Psát dál"));
    pressEscape(question()!);
    pressEscape(formDialog());
    expect(question(), "a second question, not the first one still mounted and closed").not.toBeNull();
    expect((question() as HTMLDialogElement).open).toBe(true);
  });
});

describe("a dialog that was closed by something else", () => {
  it("is opened again while the page still shows it", async () => {
    const { container } = render(
      <Modal title="Heslo" onCancel={() => false}>
        text
      </Modal>,
    );
    const dialog = dialogOf(container);
    // e.g. a form with method="dialog" inside it, or code that calls close()
    dialog.close();
    expect(dialog.open).toBe(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(dialog.open).toBe(true);
  });

  it("stays closed when the Modal closed it itself", async () => {
    const { container } = render(
      <Modal title="Otázka" onCancel={() => undefined}>
        text
      </Modal>,
    );
    const dialog = dialogOf(container);
    pressEscape(dialog);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(dialog.open).toBe(false);
  });
});

describe("the page behind", () => {
  it("does not scroll while a dialog is open, and does again when the last one is gone", () => {
    const root = document.documentElement;
    expect(root.classList.contains("modal-open")).toBe(false);
    const first = render(
      <Modal title="Jedna" onCancel={() => undefined}>
        text
      </Modal>,
    );
    expect(root.classList.contains("modal-open")).toBe(true);
    const second = render(
      <Modal title="Dvě" onCancel={() => undefined}>
        text
      </Modal>,
    );
    first.unmount();
    // one is still open: still locked
    expect(root.classList.contains("modal-open")).toBe(true);
    second.unmount();
    expect(root.classList.contains("modal-open")).toBe(false);
  });
});

describe("what the dialog is described by", () => {
  it("is nothing unless the dialog has a description (a form is not one long description)", () => {
    const { container } = render(
      <Modal title="Nový uživatel" onCancel={() => undefined}>
        <label>
          Jméno <input />
        </label>
      </Modal>,
    );
    const dialog = dialogOf(container);
    expect(dialog.hasAttribute("aria-describedby")).toBe(false);
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("is the short description when it has one", () => {
    const { container } = render(
      <Modal title="Odhlásit se?" description="Stránka má neuložené změny." onCancel={() => undefined}>
        <input />
      </Modal>,
    );
    const dialog = dialogOf(container);
    const id = dialog.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    expect(container.querySelector(`[id="${id}"]`)?.textContent).toBe("Stránka má neuložené změny.");
  });
});
