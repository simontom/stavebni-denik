// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hasUnsavedWork } from "../lib/api";
import { OneTimePasswordDialog } from "./OneTimePasswordDialog";

/**
 * The temporary password of an account, shown once. It cannot be dismissed before the person says they handed it over (Escape and
 * the button do nothing), and once the dialog is closed the password is nowhere in the page. (jsdom has no `showModal()`: the lines
 * below give it the part of its behaviour that matters. The real browser, the focus and the real server are e2e/dialogs.spec.ts.)
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

const PASSWORD = "Tajne-Heslo-Jen-Jednou-42!";

function pressEscape(dialog: HTMLElement) {
  act(() => {
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  });
}

/** A page that keeps the password in its own state, as the users page does, and forgets it when the dialog is closed. */
function Page({ onClosed = () => undefined }: { onClosed?: () => void }) {
  const [issued, setIssued] = useState<{ nickname: string; password: string } | null>({ nickname: "novak", password: PASSWORD });
  return (
    <>
      <p>Seznam uživatelů</p>
      {issued && (
        <OneTimePasswordDialog
          title="Heslo bylo obnoveno"
          intro="Předejte tyto údaje uživateli."
          nickname={issued.nickname}
          password={issued.password}
          onClosed={() => {
            onClosed();
            setIssued(null);
          }}
        />
      )}
    </>
  );
}

const dialog = () => screen.getByRole("dialog", { name: "Heslo bylo obnoveno" }) as HTMLDialogElement;

describe("a temporary password that is shown once", () => {
  it("shows who it is for and the password, which can be selected", () => {
    render(<Page />);
    expect(within(dialog()).getByText("novak")).toBeTruthy();
    const shown = within(dialog()).getByTestId("one-time-password");
    expect(shown.textContent).toBe(PASSWORD);
    expect(shown.className, "one click selects all of it").toContain("select-all");
  });

  it("cannot be dismissed before it is handed over: Escape does nothing and the button is off", () => {
    const onClosed = vi.fn();
    render(<Page onClosed={onClosed} />);
    const done = within(dialog()).getByRole("button", { name: "Hotovo" }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    pressEscape(dialog());
    fireEvent.click(done);
    expect(onClosed).not.toHaveBeenCalled();
    expect(dialog().open).toBe(true);
    expect(screen.getByTestId("one-time-password").textContent).toBe(PASSWORD);
  });

  it("is closed by the button, and by Escape, once the person says they handed it over; and the password is gone from the page", () => {
    const onClosed = vi.fn();
    const first = render(<Page onClosed={onClosed} />);
    fireEvent.click(within(dialog()).getByLabelText("Heslo jsem předal(a)"));
    expect((within(dialog()).getByRole("button", { name: "Hotovo" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Hotovo" }));
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent, "the password is not in the page any more").not.toContain(PASSWORD);
    expect(document.body.textContent).toContain("Seznam uživatelů");
    first.unmount();

    render(<Page onClosed={onClosed} />);
    fireEvent.click(within(dialog()).getByLabelText("Heslo jsem předal(a)"));
    pressEscape(dialog());
    expect(onClosed).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(PASSWORD);
  });

  it("is unsaved work until it is handed over, so that leaving the page asks first (the password cannot be shown again)", () => {
    const view = render(<Page />);
    expect(hasUnsavedWork()).toBe(true);
    fireEvent.click(within(dialog()).getByLabelText("Heslo jsem předal(a)"));
    expect(hasUnsavedWork(), "handed over: nothing is lost by leaving").toBe(false);
    fireEvent.click(within(dialog()).getByLabelText("Heslo jsem předal(a)"));
    expect(hasUnsavedWork(), "the tick was taken back").toBe(true);
    view.unmount();
    expect(hasUnsavedWork(), "gone with the dialog").toBe(false);
  });
});
