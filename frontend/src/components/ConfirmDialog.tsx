import React, { useRef, useState } from "react";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { useModal } from "./ui/modalContext";

/** What "yes" does: just a thing the page does once the dialog has closed, or an action that can fail and has a result. */
type Yes<T> = { onConfirm: () => void; action?: undefined; onDone?: undefined } | { action: () => Promise<T>; onDone?: (result: T) => void; onConfirm?: undefined };

/**
 * A small question with two answers, on the shared [Modal] (the browser's own modal `<dialog>`: focus stays inside, the page
 * behind is inert, Escape means "no"). It replaces `window.confirm`, which looks like the browser and not like the application, cannot
 * be reached by a test that has no browser dialog to accept, and cannot say what went wrong. Render it only while the question is open,
 * and stop rendering it the moment it is answered (state of the page's own).
 *
 * - [title] is the question ("Smazat uživatele?"), [children] its short explanation (the description: who, and what follows). The verb
 *   is on the confirm button ([confirmLabel]: "Smazat", "Odebrat", not "Ano"), and the safe answer ([cancelLabel], the one that changes
 *   nothing) has the focus, so a stray Enter does not throw anything away. With [destructive] (the default) the confirm button is the
 *   quiet danger button beside the primary safe one; a question that is not destructive (a confirmation of a harmless but binding
 *   act) has a primary confirm and a secondary safe answer. Cancelling closes the dialog while it is still in the document and puts
 *   the focus back on what had it before the question (the button that asked, the text being typed).
 * - **Yes, as a thing to do:** [onConfirm] runs once the dialog has closed (the page is about to change: no focus is put back).
 * - **Yes, as an action that can fail:** [action] runs while the dialog stays open: the buttons are disabled, Escape does nothing,
 *   and when the action fails its message is said *inside* the dialog (`role="alert"`), which stays open for another try or a "no".
 *   When it succeeds the dialog closes, with the focus back on the button that asked, and [onDone] gets the result (the page takes the
 *   question off its screen there, and shows what the action made). A session that ended meanwhile opens the sign-in dialog above this one;
 *   the message says so, and after signing in the same answer is given again.
 */
export function ConfirmDialog<T = void>({
  title,
  children,
  confirmLabel,
  cancelLabel,
  destructive = true,
  onCancel,
  ...yes
}: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  onCancel: () => void;
} & Yes<T>) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  return (
    // The question is short: it is the dialog's description. Escape answers "no" (onCancel), except while an action is running.
    <Modal
      title={title}
      description={children}
      onCancel={onCancel}
      dismissible={!busy}
      initialFocus={cancelButton}
      footer={<Answers {...{ confirmLabel, cancelLabel, destructive, onCancel, cancelButton, busy, setBusy, setProblem, yes }} />}
    >
      {problem && <Banner tone="danger">{problem}</Banner>}
    </Modal>
  );
}

/** The two buttons: they live inside the [Modal], so they can close it before the page reacts. */
function Answers<T>({
  confirmLabel,
  cancelLabel,
  destructive,
  onCancel,
  cancelButton,
  busy,
  setBusy,
  setProblem,
  yes,
}: {
  confirmLabel: string;
  cancelLabel: string;
  destructive: boolean;
  onCancel: () => void;
  cancelButton: React.RefObject<HTMLButtonElement | null>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setProblem: (problem: string) => void;
  yes: Yes<T>;
}) {
  const modal = useModal();

  const confirm = async () => {
    if (!yes.action) return modal.close(yes.onConfirm);
    setBusy(true);
    setProblem("");
    try {
      const result = await yes.action();
      modal.close(() => yes.onDone?.(result), { restoreFocus: true });
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Akce se nezdařila");
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant={destructive ? "danger-quiet" : "primary"} disabled={busy} onClick={() => void confirm()}>
        {confirmLabel}
      </Button>
      <Button ref={cancelButton} variant={destructive ? "primary" : "secondary"} disabled={busy} onClick={() => modal.close(onCancel, { restoreFocus: true })}>
        {cancelLabel}
      </Button>
    </>
  );
}
