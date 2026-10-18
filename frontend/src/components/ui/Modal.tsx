import { useCallback, useEffect, useId, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { ModalContext, type ModalHandle } from "./modalContext";

const sizes = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-lg" } as const;

/**
 * A modal dialog on the browser's own `<dialog>`: focus stays inside, the page behind is inert, and Escape means "cancel".
 * Render it only while it is open: it opens itself when it mounts and closes when it unmounts. It is at most as wide as the
 * screen less a margin and scrolls inside when it is taller than the screen, so no part of it is out of reach on a phone.
 *
 * - [title] is the dialog's name (`aria-labelledby`); [children] is its body, which describes it (`aria-describedby`).
 * - [footer] holds the buttons. A button that has to close the dialog first (and then do something) uses `useModal().close`.
 * - [onCancel] runs on Escape (after the dialog has closed and the focus is back). The page decides what cancelling means: the
 *   dialog stays in the document until the page stops rendering it, so the page and the dialog cannot disagree.
 * - [initialFocus] is what gets the focus when it opens: for a question that throws something away, the safe answer. Without
 *   it the browser focuses the first control inside.
 */
export function Modal({
  title,
  children,
  footer,
  onCancel,
  initialFocus,
  size = "md",
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onCancel: () => void;
  initialFocus?: RefObject<HTMLElement | null>;
  size?: keyof typeof sizes;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  // What had the focus when the dialog opened.
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !element.contains(active)) opener.current = active;
    if (!element.open) element.showModal();
    initialFocus?.current?.focus();
    return () => {
      if (element.open) element.close();
    };
  }, [initialFocus]);

  // React takes the dialog out of the document before the cleanup above can close it, and the browser then has nowhere to
  // return the focus to (it ends on <body>). So an answer closes the dialog first, and the focus is put back by hand too.
  const close = useCallback<ModalHandle["close"]>((after, options) => {
    dialog.current?.close();
    if (options?.restoreFocus && opener.current?.isConnected) opener.current.focus();
    after?.();
  }, []);
  const handle = useMemo<ModalHandle>(() => ({ close }), [close]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      // Escape: the dialog stays until the page says otherwise.
      onCancel={(e) => {
        e.preventDefault();
        close(onCancel, { restoreFocus: true });
      }}
      className={`m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${sizes[size]} overflow-y-auto rounded-lg bg-surface p-0 text-ink shadow-xl backdrop:bg-black/50`}
    >
      <ModalContext.Provider value={handle}>
        <div className="space-y-4 p-4 sm:p-6">
          <h2 id={titleId} className="text-lg font-bold text-ink">
            {title}
          </h2>
          <div id={bodyId} className="text-sm text-ink">
            {children}
          </div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">{footer}</div>}
        </div>
      </ModalContext.Provider>
    </dialog>
  );
}
