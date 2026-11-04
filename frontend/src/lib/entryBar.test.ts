import { describe, expect, it } from "vitest";
import { entryBar, type EntryBarInput } from "./entryBar";

/** A stavbyvedoucí with a saved, unsigned entry and nothing changed: the state the others are made from. */
const saved: EntryBarInput = {
  settled: true,
  canWrite: true,
  isBoss: true,
  signed: false,
  hasEntry: true,
  mayEdit: true,
  editable: true,
  dirty: false,
  saving: false,
  saved: false,
  future: false,
  draftOffer: false,
};
const with_ = (patch: Partial<EntryBarInput>): EntryBarInput => ({ ...saved, ...patch });

describe("the bar that follows the state of the entry", () => {
  it("has nothing to say until the entry and the role have loaded, and nothing for a person who does not write", () => {
    expect(entryBar(with_({ settled: false })).visible).toBe(false);
    expect(entryBar(with_({ canWrite: false, isBoss: false })).visible).toBe(false);
    expect(entryBar(with_({ canWrite: false, isBoss: false, signed: true })).visible, "a reader of a signed entry has no bar either").toBe(false);
  });

  it("offers 'Uložit záznam' for a day that has no entry yet, and the signing only as something that waits", () => {
    const bar = entryBar(with_({ hasEntry: false, dirty: true }));
    expect(bar).toMatchObject({
      visible: true,
      state: "none",
      primary: "save",
      save: { label: "Uložit záznam", disabled: false },
      sign: { disabled: true },
      pdf: false,
      hint: "save-first",
      status: "unsaved",
    });
  });

  it("offers 'Uložit změny' for an entry that has unsaved changes, with the signing off and no PDF of what is not the saved text", () => {
    const bar = entryBar(with_({ dirty: true }));
    expect(bar).toMatchObject({
      state: "dirty",
      primary: "save",
      save: { label: "Uložit změny", disabled: false },
      sign: { disabled: true },
      pdf: false,
      hint: "save-first",
      status: "unsaved",
    });
  });

  it("says 'Ukládám…' and is off while a save is on its way (one save at a time)", () => {
    expect(entryBar(with_({ dirty: true, saving: true })).save).toEqual({ label: "Ukládám…", disabled: true });
    expect(entryBar(with_({ hasEntry: false, dirty: true, saving: true })).save).toEqual({ label: "Ukládám…", disabled: true });
  });

  it("offers signing and the PDF for a saved entry without changes, and no save: there is nothing to save", () => {
    const bar = entryBar(saved);
    expect(bar).toMatchObject({ state: "saved", primary: "sign", save: null, sign: { disabled: false }, pdf: true, hint: null, status: null });
  });

  it("shows when the entry was saved, until the next change", () => {
    expect(entryBar(with_({ saved: true })).status).toBe("saved");
    expect(entryBar(with_({ saved: true, dirty: true })).status).toBe("unsaved");
    expect(entryBar(with_({ saved: true, dirty: true, saving: true })).status).toBe("unsaved");
  });

  it("offers the PDF but not the signing to a worker with a saved entry of their own", () => {
    const bar = entryBar(with_({ isBoss: false }));
    expect(bar).toMatchObject({ state: "saved", primary: "pdf", save: null, sign: null, pdf: true });
    expect(entryBar(with_({ isBoss: false, dirty: true })).sign, "a worker is never offered the signing, not even a disabled one").toBeNull();
  });

  it("keeps the signing off while a draft waits for the person's answer, and says why", () => {
    const bar = entryBar(with_({ draftOffer: true, editable: false }));
    expect(bar).toMatchObject({ state: "saved", sign: { disabled: true }, hint: "decide-draft" });
    // for a day without an entry the save is off too (the form is locked) and it is the draft that is the reason
    expect(entryBar(with_({ hasEntry: false, draftOffer: true, editable: false }))).toMatchObject({ save: { label: "Uložit záznam", disabled: true }, hint: "decide-draft" });
  });

  it("switches the save off when the form cannot be saved: a future day, a form that is still locked", () => {
    expect(entryBar(with_({ hasEntry: false, future: true })).save).toEqual({ label: "Uložit záznam", disabled: true });
    expect(entryBar(with_({ hasEntry: false, editable: false })).save).toEqual({ label: "Uložit záznam", disabled: true });
  });

  it("offers only the PDF for a signed entry, whatever else the page holds", () => {
    const bar = entryBar(with_({ signed: true, dirty: true, saved: true }));
    expect(bar).toMatchObject({ visible: true, state: "signed", primary: "pdf", save: null, sign: null, pdf: true, hint: null, status: null });
  });

  it("offers only the PDF for somebody else's unsigned entry, which a worker sees as a document", () => {
    const bar = entryBar(with_({ isBoss: false, mayEdit: false, editable: false }));
    expect(bar).toMatchObject({ state: "view", primary: "pdf", save: null, sign: null, pdf: true });
  });

  it("is one of the five states, and shows only the buttons that belong to it, for every combination of the inputs", () => {
    const bools = [false, true];
    const seen = new Set<string>();
    for (const settled of bools)
      for (const canWrite of bools)
        for (const isBoss of bools)
          for (const signed of bools)
            for (const hasEntry of bools)
              for (const mayEdit of bools)
                for (const dirty of bools)
                  for (const saving of bools)
                    for (const draftOffer of bools) {
                      // an entry that somebody else wrote, or a signed one, exists
                      const bar = entryBar({
                        settled,
                        canWrite,
                        isBoss: isBoss && canWrite,
                        signed,
                        hasEntry: hasEntry || signed || !mayEdit,
                        mayEdit,
                        editable: mayEdit && !draftOffer,
                        dirty,
                        saving,
                        saved: false,
                        future: false,
                        draftOffer,
                      });
                      if (!bar.visible) {
                        expect(bar).toMatchObject({ state: "hidden", save: null, sign: null, pdf: false, primary: null, hint: null, status: null });
                        continue;
                      }
                      seen.add(bar.state);
                      // exactly the buttons of the state
                      if (bar.state === "signed" || bar.state === "view") expect([bar.save, bar.sign]).toEqual([null, null]);
                      if (bar.state === "saved") expect(bar.save).toBeNull();
                      if (bar.state === "none" || bar.state === "dirty") expect(bar.save).not.toBeNull();
                      // the PDF is of a saved entry, and only when what is on the screen is that entry
                      expect(bar.pdf).toBe(bar.state === "saved" || bar.state === "signed" || bar.state === "view");
                      // a worker is never offered the signing; the signing is never on while there are unsaved changes or no entry
                      if (!isBoss) expect(bar.sign).toBeNull();
                      if (bar.sign && !bar.sign.disabled) expect(bar.state).toBe("saved");
                      // the main button is one of the buttons that are there
                      if (bar.primary === "save") expect(bar.save).not.toBeNull();
                      if (bar.primary === "sign") expect(bar.sign).not.toBeNull();
                      if (bar.primary === "pdf") expect(bar.pdf).toBe(true);
                    }
    expect([...seen].sort()).toEqual(["dirty", "none", "saved", "signed", "view"]);
  });
});
