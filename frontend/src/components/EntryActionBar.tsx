import { useLayoutEffect, useRef } from "react";
import type { EntryBarModel } from "../lib/entryBar";
import { useKeyboardOpen } from "../lib/useKeyboardOpen";
import { Button } from "./ui";

/**
 * The one bar of actions of the entry page (backlog B5): save, sign and the PDF in one place that follows the state of the entry
 * (`lib/entryBar.ts` decides which buttons it has and which is the main one). It sticks to the foot of the window while the page is
 * longer than it, lies after the last card at the end of the page (so it covers nothing, and the page needs no padding for it), keeps
 * the padding of the phone's safe area under its buttons (`env(safe-area-inset-bottom)`), and is out of the way while an on-screen keyboard
 * is open (`useKeyboardOpen`), because it would take a third of the little room that is left above the keys.
 *
 * **Nothing moves when the state changes** (a second tap on "Uložit změny" must not land on another button): while an entry is written the bar has
 * the same rows and the same places in every state. A line for "Neuložené změny" / "Uloženo 14:32" is always there; on a phone "Uložit změny" and the
 * PDF share the first row and "Podepsat a uzamknout" has the second; from 640 px all of it is one row, the save button with a width of its own. The place of
 * the PDF stays (invisible, and out of the tab order) while there is nothing to download yet. The bar is anchored to the foot of the window, so a row
 * that came or went would move the save button with it; that is why none does.
 *
 * The save button belongs to the form (`form`): the bar is not inside it, and Enter in a field still sends it. Its height is measured and put in
 * `--entry-bar-height` on the page (`index.css`: the page's `scroll-padding-bottom` follows it), so a control that gets the focus is scrolled out from under the bar
 * whatever its height is.
 */
export function EntryActionBar({
  model,
  formId,
  savedAt,
  signHintId,
  onSign,
  onPdf,
  pdfBusy,
}: {
  model: EntryBarModel;
  formId: string;
  /** When the form was last saved, for "Uloženo 14:32". */
  savedAt: Date | null;
  /** The element that says why the signing is off; the signing button is described by it while it is off. */
  signHintId: string;
  /** Pressed also while the signing is off: the page says why (what is unsaved, what is on its way, what failed). */
  onSign: () => void;
  onPdf: () => void;
  pdfBusy: boolean;
}) {
  const keyboardOpen = useKeyboardOpen();
  const bar = useRef<HTMLElement | null>(null);

  // The height of the bar, for the page's scroll padding (0 while it is not there or is out of the way).
  useLayoutEffect(() => {
    const el = bar.current;
    const root = document.documentElement;
    if (!el) return;
    const measure = () => root.style.setProperty("--entry-bar-height", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    measure();
    if (typeof ResizeObserver === "undefined") return () => root.style.removeProperty("--entry-bar-height");
    const watcher = new ResizeObserver(measure);
    watcher.observe(el);
    return () => {
      watcher.disconnect();
      root.style.removeProperty("--entry-bar-height");
    };
  }, [model.visible]);

  if (!model.visible) return null;
  const { save, sign } = model;
  // The states in which the entry is written: the same rows in all of them. Signed and somebody else's entry have the PDF only.
  const writing = model.state === "none" || model.state === "dirty" || model.state === "saved";
  return (
    <section
      ref={bar}
      aria-label="Akce záznamu"
      data-entry-bar=""
      hidden={keyboardOpen}
      className="sticky bottom-0 z-30 -mx-4 border-t border-line bg-surface px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4"
    >
      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 sm:flex sm:flex-wrap sm:items-center sm:justify-end sm:gap-2">
        {writing && (
          <div className="col-span-2 min-h-5 text-sm sm:order-first sm:mr-auto sm:min-h-0 sm:flex-1">
            {model.status === "unsaved" && <span className="font-medium text-warning-ink">Neuložené změny</span>}
            {model.status === "saved" && savedAt && (
              <span role="status" className="text-success-ink">
                Uloženo {savedAt.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
          </div>
        )}
        {save && (
          <Button
            type="submit"
            form={formId}
            size="sm"
            variant={model.primary === "save" ? "primary" : "secondary"}
            disabled={save.disabled}
            className="w-full sm:w-auto sm:min-w-[9.5rem]"
          >
            {save.label}
          </Button>
        )}
        {(model.pdf || writing) && (
          <Button
            size="sm"
            variant={model.primary === "pdf" ? "primary" : "secondary"}
            aria-disabled={pdfBusy || undefined}
            // the place of the PDF stays while there is nothing to download: invisible, so neither seen, nor focused, nor read
            aria-hidden={model.pdf ? undefined : true}
            tabIndex={model.pdf ? undefined : -1}
            onClick={() => !pdfBusy && onPdf()}
            className={model.pdf ? (writing ? "w-full sm:w-auto" : "col-span-2 w-full sm:col-span-1 sm:w-auto") : "invisible w-full sm:w-auto"}
          >
            {pdfBusy ? "Připravuji PDF…" : "Stáhnout PDF"}
          </Button>
        )}
        {sign && (
          <Button
            size="sm"
            variant={sign.disabled ? "secondary" : "danger"}
            // Off, but still there for the keyboard and for a screen reader (not `disabled`): it is described by the reason, and pressing it says the reason in the alert.
            aria-disabled={sign.disabled || undefined}
            aria-describedby={sign.disabled && model.hint ? signHintId : undefined}
            onClick={onSign}
            className="col-span-2 w-full sm:col-span-1 sm:w-auto"
          >
            Podepsat a uzamknout
          </Button>
        )}
      </div>
    </section>
  );
}
