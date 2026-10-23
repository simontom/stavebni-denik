import { useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { flushSync } from "react-dom";
import { Button } from "./Button";
import { ModalContext, useModal, type ModalHandle } from "./modalContext";
import { lockScroll } from "./scrollLock";

const sizes = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-lg" } as const;

/**
 * After an answer the focus must be somewhere: when what had it (the button that asked) is gone with the answer, it would be on `<body>`,
 * and a keyboard user would start again from the top of the document. So, when nothing has the focus: the place the page named
 * ([fallback]), else the main heading of the page, else the page's `<main>` itself. A page that put the focus somewhere itself is left alone.
 */
function settleFocus(opener: HTMLElement | null, fallback?: () => HTMLElement | null): void {
  // Something had the focus when the dialog opened and is gone now (nothing did: the dialog was opened by the page itself, and the focus is left where it is).
  if (!opener || opener === document.body || opener.isConnected) return;
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  const target = fallback?.() ?? document.querySelector<HTMLElement>("main h1") ?? document.querySelector<HTMLElement>("main");
  if (!target) return;
  // A heading is not focusable by itself: it can take the focus (and is not in the Tab order) with a tabindex of -1.
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  // The page stays where it is: the focus is for the keyboard and the screen reader, not a jump to the top.
  target.focus({ preventScroll: true });
}

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
 * - [footer] holds the buttons. A button that has to close the dialog first (and then do something) uses `useModal().close`; the
 *   button that cancels uses `useModal().cancel`, which is Escape.
 * - **Escape never closes the dialog by itself**: the browser's closing is cancelled and the dialog decides. While [dismissible]
 *   is false (saving, a one-time password that has not been written down) Escape does nothing. Otherwise [onCancel] runs, and when
 *   it returns `false` the dialog stays open too; any other answer means "go": the dialog closes (still in the document, so
 *   the browser can do its part), the focus goes back to what had it before, and the page stops rendering the dialog.
 * - **A dialog that holds typed text says so with [unsaved]**, and then neither Escape nor `cancel()` throws the text away: they ask
 *   "Zahodit rozepsané?" first, in a modal question of its own that stacks on top of this dialog. "Psát dál" (the safe answer, in
 *   focus) and Escape on the question keep everything as it was, with the focus back where it was; "Zahodit" closes this dialog like
 *   any other cancel (so [onCancel] runs, the focus goes back to the opener). A password that is typed to confirm an action is not
 *   text worth keeping and does not count. A dialog that is [dismissible]=false is neither asked about nor closed. The backdrop does
 *   nothing: a click beside a dialog is no answer.
 * - A dialog that something else closed (a `<form method="dialog">`, a call to `close()`) while the page still shows it is
 *   opened again: a closed dialog that is still mounted would be dead weight that nothing reopens.
 * - [initialFocus] is what gets the focus when it opens: for a question that throws something away, the safe answer. Without
 *   it the browser focuses the first control inside.
 * - [handleRef] gives the component that renders the Modal the same handle `useModal()` gives what is inside it (`close`, `cancel`),
 *   so a dialog that keeps its state in one component can close itself once its request has been answered
 *   (`modal.current?.close(() => onSaved(saved), { restoreFocus: true })`) without a child component of its own.
 */
export function Modal({
  title,
  description,
  children,
  footer,
  onCancel,
  dismissible = true,
  unsaved = false,
  initialFocus,
  handleRef,
  size = "md",
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onCancel: () => void | boolean;
  dismissible?: boolean;
  unsaved?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  handleRef?: Ref<ModalHandle>;
  size?: keyof typeof sizes;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  // What had the focus when the dialog opened.
  const opener = useRef<HTMLElement | null>(null);
  // True while this component is the one closing the dialog (so that its `close` event is not taken for somebody else's).
  const closing = useRef(false);
  // The question "Zahodit rozepsané?" is open (state of this component: it is taken off the page the moment it is answered).
  const [asking, setAsking] = useState(false);
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
    if (!options?.restoreFocus) return after?.();
    if (opener.current?.isConnected) opener.current.focus();
    // What the answer does to the page (a deleted row, an acknowledgement that takes its button away) is drawn now, so that "the opener is
    // still there" is judged on the page as it is after the answer. Without it the focus would be put on a button that React then removes.
    if (after) flushSync(() => after());
    settleFocus(opener.current, options.fallback);
  }, []);

  // Escape, and the "Zrušit" button: the same decision. A dialog that is saving does not move; one with typed text asks; the
  // page may refuse (`false`); otherwise it is closed and the page stops rendering it.
  const cancel = useCallback(() => {
    if (!dismissible) return;
    if (unsaved) return setAsking(true);
    if (onCancel() === false) return;
    close(undefined, { restoreFocus: true });
  }, [dismissible, unsaved, onCancel, close]);

  const handle = useMemo<ModalHandle>(() => ({ close, cancel }), [close, cancel]);
  useImperativeHandle(handleRef, () => handle, [handle]);

  return (
    <>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        // Escape: the browser would close the dialog; this does not let it. The dialog is only closed when the page has agreed.
        onCancel={(e) => {
          e.preventDefault();
          cancel();
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
      {asking && (
        <DiscardQuestion
          onKeep={() => setAsking(false)}
          onDiscard={() => {
            setAsking(false);
            close(onCancel, { restoreFocus: true });
          }}
        />
      )}
    </>
  );
}

/**
 * "Zahodit rozepsané?": the question a [Modal] with typed text asks before it is cancelled. It has the shape of `ConfirmDialog`
 * (which cannot be used here: it is built on this component), with the safe answer in focus.
 */
function DiscardQuestion({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      title="Zahodit rozepsané?"
      description="Napsaný text se neuloží. Když ho zahodíte, ztratí se."
      size="sm"
      onCancel={onKeep}
      initialFocus={keep}
      footer={<DiscardAnswers keep={keep} onKeep={onKeep} onDiscard={onDiscard} />}
    />
  );
}

/** The two answers; they are inside the question, so they can close it before the page reacts. */
function DiscardAnswers({ keep, onKeep, onDiscard }: { keep: RefObject<HTMLButtonElement | null>; onKeep: () => void; onDiscard: () => void }) {
  const modal = useModal();
  return (
    <>
      <Button variant="danger-quiet" onClick={() => modal.close(onDiscard)}>
        Zahodit
      </Button>
      <Button ref={keep} onClick={() => modal.close(onKeep, { restoreFocus: true })}>
        Psát dál
      </Button>
    </>
  );
}
