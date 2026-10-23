import React, { useRef, useState } from "react";
import { useStalled } from "../lib/useStalled";
import { useUnsavedWork } from "../lib/useUnsavedWork";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { useModal } from "./ui/modalContext";
import { StalledNotice } from "./ui/StalledNotice";

/** What "yes" does: just a thing the page does once the dialog has closed, or an action that can fail and has a result. */
type Yes<T> = { onConfirm: () => void; action?: undefined; onDone?: undefined } | { action: () => Promise<T>; onDone?: (result: T) => void; onConfirm?: undefined };

/** What leaving the page loses while an action runs, when the page did not say (the leave question shows it). */
const DEFAULT_LEAVE_MESSAGE = "Právě se provádí akce. Když odejdete, nedozvíte se, jak dopadla.";

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
 *   act) has a primary confirm button. Cancelling closes the dialog while it is still in the document and puts
 *   the focus back on what had it before the question (the button that asked, the text being typed).
 * - **Yes, as a thing to do:** [onConfirm] runs once the dialog has closed (the page is about to change: no focus is put back).
 * - **Yes, as an action that can fail:** [action] runs while the dialog stays open: the buttons are off (`aria-disabled`, not `disabled`:
 *   the one that was pressed keeps the focus, so after a refusal the same key can be pressed again) and Escape does nothing, and when the
 *   action fails its message is said *inside* the dialog (`role="alert"`), which stays open for another try or a "no". When it succeeds the
 *   dialog closes, with the focus back on the button that asked (or, when that button is gone with the answer, on the main heading of the
 *   page: see `Modal`), and [onDone] gets the result (the page takes the question off its screen there, and shows what the action made).
 *   A session that ended meanwhile opens the sign-in dialog above this one; the message says so, and after signing in the same answer is given again.
 * - **While the action runs the page counts as holding unsaved work** (`useUnsavedWork`): a link or the Back button asks first, and the
 *   browser asks before the tab is closed. [leaveMessage] says in words what leaving loses (for a new password: that it will not be shown).
 * - **A server that does not answer** is not waited for for ever: after 20 s the dialog says "Server neodpovídá." and [stalledNote] (what may or may not
 *   have happened, and what to check), and "Zavřít" (the safe button, now on again) and Escape close it. Closing does not say the action failed
 *   or succeeded. Nothing is aborted: an answer that comes later still reaches [onDone], and a request that was aborted could lose a result the server made.
 */
export function ConfirmDialog<T = void>({
  title,
  children,
  confirmLabel,
  cancelLabel,
  destructive = true,
  leaveMessage,
  stalledNote,
  onCancel,
  ...yes
}: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  leaveMessage?: string;
  stalledNote?: React.ReactNode;
  onCancel: () => void;
} & Yes<T>) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const stalled = useStalled(busy);
  // The person closed the dialog while the action was still running (the server did not answer): its late answer must not take the focus.
  const abandoned = useRef(false);
  useUnsavedWork(busy, { message: leaveMessage ?? DEFAULT_LEAVE_MESSAGE });
  const no = () => {
    abandoned.current = busy;
    onCancel();
  };
  const wasAbandoned = () => abandoned.current;
  return (
    // The question is short: it is the dialog's description. Escape answers "no", except while an action is running (until it has stalled).
    <Modal
      title={title}
      description={children}
      onCancel={no}
      dismissible={!busy || stalled}
      initialFocus={cancelButton}
      footer={<Answers {...{ confirmLabel, cancelLabel, destructive, no, cancelButton, busy, stalled, wasAbandoned, setBusy, setProblem, yes }} />}
    >
      {problem && <Banner tone="danger">{problem}</Banner>}
      {stalled && <StalledNotice>{stalledNote}</StalledNotice>}
    </Modal>
  );
}

/** The two buttons: they live inside the [Modal], so they can close it before the page reacts. */
function Answers<T>({
  confirmLabel,
  cancelLabel,
  destructive,
  no,
  cancelButton,
  busy,
  stalled,
  wasAbandoned,
  setBusy,
  setProblem,
  yes,
}: {
  confirmLabel: string;
  cancelLabel: string;
  destructive: boolean;
  no: () => void;
  cancelButton: React.RefObject<HTMLButtonElement | null>;
  busy: boolean;
  stalled: boolean;
  wasAbandoned: () => boolean;
  setBusy: (busy: boolean) => void;
  setProblem: (problem: string) => void;
  yes: Yes<T>;
}) {
  const modal = useModal();

  const confirm = async () => {
    if (busy) return;
    if (!yes.action) return modal.close(yes.onConfirm);
    setBusy(true);
    setProblem("");
    try {
      const result = await yes.action();
      modal.close(() => yes.onDone?.(result), { restoreFocus: !wasAbandoned() });
    } catch (err) {
      if (wasAbandoned()) return;
      setProblem(err instanceof Error ? err.message : "Akce se nezdařila");
      setBusy(false);
    }
  };

  // Off while the action runs, but not `disabled`: the button that was pressed keeps the focus, and Tab does not skip the other one. Once
  // the server has not answered for long the safe button is the way out and is on again, as "Zavřít".
  const cancelOff = busy && !stalled;
  return (
    <>
      <Button variant={destructive ? "danger-quiet" : "primary"} aria-disabled={busy || undefined} onClick={() => void confirm()}>
        {confirmLabel}
      </Button>
      <Button
        ref={cancelButton}
        variant={destructive ? "primary" : "secondary"}
        aria-disabled={cancelOff || undefined}
        onClick={() => {
          if (cancelOff) return;
          modal.close(no, { restoreFocus: true });
        }}
      >
        {stalled ? "Zavřít" : cancelLabel}
      </Button>
    </>
  );
}
