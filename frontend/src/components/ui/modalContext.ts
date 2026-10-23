import { createContext, useContext } from "react";

/** What something inside a [Modal] (its footer, its body) can do: close it, or cancel it. */
export interface ModalHandle {
  /**
   * Closes the dialog (while it is still in the document, so the browser can do its part) and then runs [after]. With
   * `restoreFocus` the focus goes back to what had it before the dialog opened (the link or the button that was used, the
   * text being typed), so a keyboard user does not start again from the top of the page; leave it off when the page is about to change.
   */
  close: (after?: () => void, options?: { restoreFocus?: boolean }) => void;
  /**
   * What the "Zrušit" button does: exactly what Escape does. Nothing while the dialog is not dismissible (it is saving); a question
   * "Zahodit rozepsané?" while it holds typed text; otherwise the page's `onCancel` runs (unless it refuses) and the dialog closes with the
   * focus back on the opener.
   */
  cancel: () => void;
}

export const ModalContext = createContext<ModalHandle | null>(null);

/** The [ModalHandle] of the dialog this is rendered in. */
export function useModal(): ModalHandle {
  const modal = useContext(ModalContext);
  if (!modal) throw new Error("useModal must be used inside a <Modal>");
  return modal;
}
