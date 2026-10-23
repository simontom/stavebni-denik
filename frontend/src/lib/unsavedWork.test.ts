import { afterEach, describe, expect, it } from "vitest";
import { discardUnsavedWork, hasUnsavedWork, registerUnsavedWork, setUnsavedWork, unsavedWorkIsKeptAsDraft, unsavedWorkMessage } from "./unsavedWork";

/**
 * What the application knows about work that leaving would lose: the page's own slot (`setUnsavedWork`: the entry's form and the
 * project's identification form) and the registrations of dialogs and questions (`registerUnsavedWork`: each takes itself away, and
 * one cannot take away another's). The leave question and the browser's own question (`beforeunload`) both read it.
 */
afterEach(discardUnsavedWork);

describe("registrations", () => {
  it("count until they are taken away, each by its own", () => {
    expect(hasUnsavedWork()).toBe(false);
    const first = registerUnsavedWork();
    const second = registerUnsavedWork();
    expect(hasUnsavedWork()).toBe(true);
    first();
    expect(hasUnsavedWork(), "the second is still there").toBe(true);
    second();
    expect(hasUnsavedWork()).toBe(false);
    second();
    expect(hasUnsavedWork(), "taking one away twice is harmless").toBe(false);
  });

  it("do not take away the page's own slot, and the slot does not take away theirs", () => {
    setUnsavedWork(true);
    const dialog = registerUnsavedWork();
    setUnsavedWork(false);
    expect(hasUnsavedWork(), "the dialog's registration stays").toBe(true);
    dialog();
    expect(hasUnsavedWork()).toBe(false);

    const again = registerUnsavedWork();
    setUnsavedWork(true);
    again();
    expect(hasUnsavedWork(), "the page's slot stays").toBe(true);
  });

  it("are all given up when the person says so (logging out, leaving for good)", () => {
    setUnsavedWork(true, true);
    registerUnsavedWork({ message: "x" });
    discardUnsavedWork();
    expect(hasUnsavedWork()).toBe(false);
    expect(unsavedWorkMessage()).toBeUndefined();
  });
});

describe("what the leave question says", () => {
  it("says the message of the latest registration that has one, and nothing when none has", () => {
    registerUnsavedWork();
    expect(unsavedWorkMessage()).toBeUndefined();
    registerUnsavedWork({ message: "První" });
    const last = registerUnsavedWork({ message: "Druhá" });
    expect(unsavedWorkMessage()).toBe("Druhá");
    last();
    expect(unsavedWorkMessage()).toBe("První");
  });

  it("is a text kept as a draft only when everything that is unsaved is kept", () => {
    setUnsavedWork(true, true);
    expect(unsavedWorkIsKeptAsDraft()).toBe(true);
    const typed = registerUnsavedWork();
    expect(unsavedWorkIsKeptAsDraft(), "a dialog's text is not in the draft").toBe(false);
    typed();
    setUnsavedWork(false);
    expect(unsavedWorkIsKeptAsDraft(), "nothing unsaved is nothing kept").toBe(false);
  });
});
