// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  dialog.dispatchEvent(event);
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
