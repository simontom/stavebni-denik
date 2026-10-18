import React, { useEffect, useId, useRef } from "react";

/**
 * A small question with two answers, on the browser's own modal `<dialog>` (focus stays inside, the page behind is inert,
 * Escape means "cancel"). Render it only while the question is open: it opens itself on mount. The safe answer
 * ([cancelLabel], the one that changes nothing) has the focus, so a stray Enter does not throw anything away. Answering
 * closes the dialog while it is still in the document and puts the focus back on what had it before the question (the link or
 * the button that was used, the text being typed), so a keyboard user does not start again from the top of the page.
 * (Backlog B6 replaces the application's dialogs with one shared component; this is a deliberate stand-in, not `window.confirm`.)
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
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  // What had the focus when the question opened.
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !element.contains(active)) opener.current = active;
    if (!element.open) element.showModal();
    cancelButton.current?.focus();
    return () => {
      if (element.open) element.close();
    };
  }, []);

  // React takes the dialog out of the document before the cleanup above can close it, and the browser then has nowhere to
  // return the focus to (it ends on <body>). So the answer closes the dialog first, and the focus is put back by hand too.
  const cancel = () => {
    dialog.current?.close();
    if (opener.current?.isConnected) opener.current.focus();
    onCancel();
  };
  const confirm = () => {
    dialog.current?.close();
    onConfirm();
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      // Escape: the dialog stays until the page says otherwise, so the page and the dialog cannot disagree.
      onCancel={(e) => {
        e.preventDefault();
        cancel();
      }}
      className="m-auto w-full max-w-md rounded-lg bg-white p-0 text-gray-900 shadow-xl backdrop:bg-black/50"
    >
      <div className="space-y-4 p-6">
        <h2 id={titleId} className="text-lg font-bold text-gray-900">
          {title}
        </h2>
        <div id={bodyId} className="text-sm text-gray-700">
          {children}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-gray-200 pt-3">
          <button type="button" onClick={confirm} className="rounded border border-gray-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50">
            {confirmLabel}
          </button>
          <button ref={cancelButton} type="button" onClick={cancel} className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
            {cancelLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
