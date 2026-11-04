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
 * The save button belongs to the form (`form`): the bar is not inside it, and Enter in a field still sends it. `index.css` gives the page
 * a `scroll-padding-bottom` while the bar is there, so a control that gets the focus is scrolled out from under it.
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
  onSign: () => void;
  onPdf: () => void;
  pdfBusy: boolean;
}) {
  const keyboardOpen = useKeyboardOpen();
  if (!model.visible) return null;
  const { save, sign } = model;
  return (
    <section
      aria-label="Akce záznamu"
      data-entry-bar=""
      hidden={keyboardOpen}
      className="sticky bottom-0 z-30 -mx-4 border-t border-line bg-surface px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4"
    >
      <div className="flex flex-wrap items-center justify-end gap-2">
        {model.status === "unsaved" && <span className="basis-full text-sm font-medium text-warning-ink sm:flex-1 sm:basis-0">Neuložené změny</span>}
        {model.status === "saved" && savedAt && (
          <span role="status" className="basis-full text-sm text-success-ink sm:flex-1 sm:basis-0">
            Uloženo {savedAt.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        {model.pdf && (
          <Button size="sm" variant={model.primary === "pdf" ? "primary" : "secondary"} aria-disabled={pdfBusy || undefined} onClick={() => !pdfBusy && onPdf()}>
            {pdfBusy ? "Připravuji PDF…" : "Stáhnout PDF"}
          </Button>
        )}
        {save && (
          <Button type="submit" form={formId} size="sm" variant={model.primary === "save" ? "primary" : "secondary"} disabled={save.disabled}>
            {save.label}
          </Button>
        )}
        {sign && (
          <Button
            size="sm"
            variant={sign.disabled ? "secondary" : "danger"}
            disabled={sign.disabled}
            aria-describedby={sign.disabled && model.hint ? signHintId : undefined}
            onClick={onSign}
          >
            Podepsat a uzamknout
          </Button>
        )}
      </div>
    </section>
  );
}
