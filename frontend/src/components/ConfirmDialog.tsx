import React, { useRef } from "react";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { useModal } from "./ui/modalContext";

/**
 * A small question with two answers, on the shared [Modal] (the browser's own modal `<dialog>`: focus stays inside, the page
 * behind is inert, Escape means "cancel"). Render it only while the question is open. The safe answer ([cancelLabel], the one
 * that changes nothing) has the focus, so a stray Enter does not throw anything away. Cancelling closes the dialog while it is still in
 * the document and puts the focus back on what had it before the question (the link or the button that was used, the text
 * being typed); confirming just closes it, because the page is about to change.
 * (Backlog B6 moves the application's other dialogs onto the same [Modal]; this one is a deliberate stand-in for `window.confirm`.)
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  return (
    // The question is short: it is the dialog's description. Escape answers "no" (onCancel) and is never refused.
    <Modal
      title={title}
      description={children}
      onCancel={onCancel}
      initialFocus={cancelButton}
      footer={<Answers {...{ confirmLabel, cancelLabel, onConfirm, onCancel, cancelButton }} />}
    />
  );
}

/** The two buttons: they live inside the [Modal], so they can close it before the page reacts. */
function Answers({
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  cancelButton,
}: {
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  cancelButton: React.RefObject<HTMLButtonElement | null>;
}) {
  const modal = useModal();
  return (
    <>
      <Button variant="danger-quiet" onClick={() => modal.close(onConfirm)}>
        {confirmLabel}
      </Button>
      <Button ref={cancelButton} onClick={() => modal.close(onCancel, { restoreFocus: true })}>
        {cancelLabel}
      </Button>
    </>
  );
}
