/**
 * The one bar of actions at the foot of the entry page (backlog B5), as plain logic so the unit tests cover it. It follows the state of
 * the entry, so a person on a site, with a phone in one hand, is shown the next thing to do and not a form's three buttons:
 *
 *  - no entry saved yet: "Uložit záznam" (the signing waits, switched off);
 *  - unsaved changes: "Uložit změny" (the signing waits; a PDF of the stored text is not offered next to text that is not stored);
 *  - saved, nothing changed, not signed: "Podepsat a uzamknout" (the stavbyvedoucí only) and "Stáhnout PDF"; nothing is left to save;
 *  - signed: "Stáhnout PDF" only (the entry is a document);
 *  - somebody else's unsigned entry (a worker sees it as a document): "Stáhnout PDF" only.
 *
 * Only the people who write the diary (stavbyvedoucí, pracovník) have a bar. What the rules of saving and signing say is not decided
 * here: the page passes what it knows (`editable`, `dirty`, `draftOffer`), exactly as it did before for the buttons inside the form,
 * and the buttons are the same: nothing becomes possible that was not, and a button that is off says so instead of vanishing.
 */

export interface EntryBarInput {
  /** The entry and the person's role in the project have loaded. */
  settled: boolean;
  /** The person writes the diary of this project (stavbyvedoucí or pracovník). */
  canWrite: boolean;
  /** The person is the stavbyvedoucí of the project: the one who signs. */
  isBoss: boolean;
  signed: boolean;
  /** An entry is stored for this day. */
  hasEntry: boolean;
  /** The person may change this entry (`canEdit` of the server for an entry that exists, the role for a day nobody wrote). */
  mayEdit: boolean;
  /** The form can be typed into and sent now (loaded, not signed, no draft waiting for an answer). */
  editable: boolean;
  /** The form holds changes that are not saved. */
  dirty: boolean;
  /** A save is on its way. */
  saving: boolean;
  /** The form was saved (in this visit): "Uloženo HH:MM" shows until the next change. */
  saved: boolean;
  /** The day has not come yet: no entry can be made for it. */
  future: boolean;
  /** A draft kept on the device waits for the person to take it or throw it away. */
  draftOffer: boolean;
}

export type EntryBarState = "hidden" | "none" | "dirty" | "saved" | "signed" | "view";

export interface EntryBarModel {
  visible: boolean;
  state: EntryBarState;
  /** The save button, or null when there is nothing to save. */
  save: { label: "Uložit záznam" | "Uložit změny" | "Ukládám…"; disabled: boolean } | null;
  /** The signing, or null when the person is not the one who signs. Present but off while it cannot be done yet. */
  sign: { disabled: boolean } | null;
  pdf: boolean;
  /** The button that is the point of the bar in this state (the one that is drawn as the main one). */
  primary: "save" | "sign" | "pdf" | null;
  /** Why the signing is off, when it is: a draft waits for an answer, or there is nothing saved to sign. */
  hint: "save-first" | "decide-draft" | null;
  /** What the person is told next to the buttons: unsaved changes, or when it was saved. */
  status: "unsaved" | "saved" | null;
}

const HIDDEN: EntryBarModel = { visible: false, state: "hidden", save: null, sign: null, pdf: false, primary: null, hint: null, status: null };

export function entryBar(input: EntryBarInput): EntryBarModel {
  if (!input.settled || !input.canWrite) return HIDDEN;
  if (input.signed) return { ...HIDDEN, visible: true, state: "signed", pdf: true, primary: "pdf" };
  if (!input.mayEdit) return { ...HIDDEN, visible: true, state: "view", pdf: input.hasEntry, primary: input.hasEntry ? "pdf" : null };

  const state: EntryBarState = !input.hasEntry ? "none" : input.dirty || input.saving ? "dirty" : "saved";
  const status = input.dirty ? "unsaved" : input.saved && !input.saving ? "saved" : null;
  // The signing is on only for a saved entry with nothing changed, no save on its way and no draft waiting: a signature covers the saved text.
  const signOff = input.dirty || input.saving || !input.hasEntry || input.draftOffer;
  const sign = input.isBoss ? { disabled: signOff } : null;
  const hint = sign?.disabled ? (input.draftOffer ? "decide-draft" : "save-first") : null;

  if (state === "saved") return { visible: true, state, save: null, sign, pdf: true, primary: sign ? "sign" : "pdf", hint, status };
  const label = input.saving ? "Ukládám…" : input.hasEntry ? "Uložit změny" : "Uložit záznam";
  const save = { label, disabled: !input.editable || input.future || input.saving } as const;
  return { visible: true, state, save, sign, pdf: false, primary: "save", hint, status };
}
