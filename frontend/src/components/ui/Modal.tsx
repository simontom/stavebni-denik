import { useCallback, useEffect, useId, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { ModalContext, type ModalHandle } from "./modalContext";
import { lockScroll } from "./scrollLock";

const sizes = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-lg" } as const;

/**
 * A modal dialog on the browser's own `<dialog>`: focus stays inside, the page behind is inert and does not scroll, and Escape means
 * "cancel". Render it only while it is open: it opens itself when it mounts and closes when it unmounts. A page must stop rendering it
 * as soon as it has been answered (state of its own, not a state that arrives later, such as the router's): a dialog that has closed
 * itself and is still rendered is not opened again, not even for a new question. It is at most as wide as
 * the screen less a margin and scrolls inside when it is taller than the screen, so no part of it is out of reach on a phone.
 *
 * - [title] is the dialog's name (`aria-labelledby`).
 * - [description] is a short sentence that says what the dialog is about (`aria-describedby`); a dialog without one has no
 *   description, because a form is not one long description. [children] is the body.
 * - [footer] holds the buttons. A button that has to close the dialog first (and then do something) uses `useModal().close`.
 * - **Escape never closes the dialog by itself**: the browser's closing is cancelled and the dialog decides. While [dismissible]
 *   is false (saving, a one-time password that has not been written down) Escape does nothing. Otherwise [onCancel] runs, and when
 *   it returns `false` the dialog stays open too; any other answer means "go": the dialog closes (still in the document, so
 *   the browser can do its part), the focus goes back to what had it before, and the page stops rendering the dialog.
 * - A dialog that something else closed (a `<form method="dialog">`, a call to `close()`) while the page still shows it is
 *   opened again: a closed dialog that is still mounted would be dead weight that nothing reopens.
 * - [initialFocus] is what gets the focus when it opens: for a question that throws something away, the safe answer. Without
 *   it the browser focuses the first control inside.
 */
export function Modal({
  title,
  description,
  children,
  footer,
  onCancel,
  dismissible = true,
  initialFocus,
  size = "md",
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onCancel: () => void | boolean;
  dismissible?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  size?: keyof typeof sizes;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  // What had the focus when the dialog opened.
  const opener = useRef<HTMLElement | null>(null);
  // True while this component is the one closing the dialog (so that its `close` event is not taken for somebody else's).
  const closing = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !element.contains(active)) opener.current = active;
    if (!element.open) element.showModal();
    initialFocus?.current?.focus();
    const unlock = lockScroll();
    return () => {
      closing.current = true;
      unlock();
      if (element.open) element.close();
    };
  }, [initialFocus]);

  // React takes the dialog out of the document before the cleanup above can close it, and the browser then has nowhere to
  // return the focus to (it ends on <body>). So an answer closes the dialog first, and the focus is put back by hand too.
  const close = useCallback<ModalHandle["close"]>((after, options) => {
    closing.current = true;
    dialog.current?.close();
    if (options?.restoreFocus && opener.current?.isConnected) opener.current.focus();
    after?.();
  }, []);
  const handle = useMemo<ModalHandle>(() => ({ close }), [close]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      // Escape: the browser would close the dialog; this does not let it. The dialog is only closed when the page has agreed.
      onCancel={(e) => {
        e.preventDefault();
        if (!dismissible) return;
        if (onCancel() === false) return;
        close(undefined, { restoreFocus: true });
      }}
      // Closed by something other than this component while it is still there: open it again.
      onClose={(e) => {
        const element = e.currentTarget;
        if (closing.current || !element.isConnected || element.open) return;
        element.showModal();
      }}
      className={`m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${sizes[size]} overflow-y-auto rounded-lg bg-surface p-0 text-ink shadow-xl backdrop:bg-black/50`}
    >
      <ModalContext.Provider value={handle}>
        <div className="space-y-4 p-4 sm:p-6">
          <h2 id={titleId} className="text-lg font-bold text-ink">
            {title}
          </h2>
          {description && (
            <p id={descriptionId} className="text-sm text-ink">
              {description}
            </p>
          )}
          {children}
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">{footer}</div>}
        </div>
      </ModalContext.Provider>
    </dialog>
  );
}
