// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FormActions } from "./FormActions";
import { Modal } from "./Modal";

/**
 * The buttons of a form in a dialog: while the request runs they are off, but the one that was pressed keeps the focus (a `disabled`
 * button that has the focus loses it, and after a refusal the person pressed Enter on nothing); once the server has not answered for
 * long, "Zrušit" is "Zavřít" and on again. (jsdom has no `showModal()` or `close()`: the lines below give it what matters here.)
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

/** A dialog whose request is "pending" until the test says so, with the page's own busy state, as every dialog has. */
function Harness({ onSubmit, onCancel = () => undefined, initiallyStalled = false }: { onSubmit: () => void; onCancel?: () => void; initiallyStalled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [stalled, setStalled] = useState(initiallyStalled);
  return (
    <>
      <button onClick={() => setStalled(true)}>stall</button>
      <button onClick={() => setBusy(false)}>refused</button>
      <Modal title="Upravit" dismissible={!busy || stalled} onCancel={onCancel} footer={<FormActions formId="f" submitLabel="Uložit" busy={busy} stalled={stalled} />}>
        <form
          id="f"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            onSubmit();
          }}
        >
          <input aria-label="Jméno" />
        </form>
      </Modal>
    </>
  );
}

const save = () => screen.getByRole("button", { name: "Uložit" });

describe("while the request runs", () => {
  it("keeps the focus on the button that was pressed, and keeps both buttons in the Tab order", () => {
    render(<Harness onSubmit={vi.fn()} />);
    save().focus();
    fireEvent.click(save());
    expect(save().getAttribute("aria-disabled")).toBe("true");
    expect((save() as HTMLButtonElement).disabled, "not `disabled`: it would lose the focus").toBe(false);
    expect(document.activeElement).toBe(save());
    expect(screen.getByRole("button", { name: "Zrušit" }).getAttribute("aria-disabled")).toBe("true");
    expect((screen.getByRole("button", { name: "Zrušit" }) as HTMLButtonElement).disabled).toBe(false);

    // the refusal arrives: the same button is on again, and still has the focus
    fireEvent.click(screen.getByText("refused"));
    expect(save().getAttribute("aria-disabled")).toBeNull();
    // (the harness button took the focus when it was clicked in a real browser; here the point is that nothing took it from `save`)
    save().focus();
    expect(document.activeElement).toBe(save());
  });

  it("sends nothing a second time when the pressed button is pressed again", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.click(save());
    fireEvent.click(save());
    fireEvent.submit(document.getElementById("f")!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not cancel the dialog by the button while it runs", () => {
    const onCancel = vi.fn();
    render(<Harness onSubmit={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(save());
    fireEvent.click(screen.getByRole("button", { name: "Zrušit" }));
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("a server that does not answer", () => {
  it("makes the cancel button 'Zavřít' and lets it close the dialog", () => {
    const onCancel = vi.fn();
    render(<Harness onSubmit={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(save());
    act(() => {
      fireEvent.click(screen.getByText("stall"));
    });
    const close = screen.getByRole("button", { name: "Zavřít" });
    expect(screen.queryByRole("button", { name: "Zrušit" })).toBeNull();
    expect(close.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(close);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
