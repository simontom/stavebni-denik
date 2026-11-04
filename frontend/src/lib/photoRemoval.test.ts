import { describe, expect, it } from "vitest";
import { REMOVED_STATUS, photosFromServer, removalFocusTarget, removeButtonId, removeButtonLabel, showsRemove, type PhotoItem } from "./photoRemoval";

const photo = (id: string, canDelete: boolean, name?: string): PhotoItem => ({ id, url: `/api/photos/${id}`, canDelete, ...(name ? { name } : {}) });

describe("showsRemove (the button is offered exactly where the server says the removal would be accepted)", () => {
  it("is offered for a photo the server says may be removed, on an entry that is not signed", () => {
    expect(showsRemove(photo("a", true), false)).toBe(true);
  });

  it("is not offered for a photo the server says may not be removed (somebody else's, for a worker; any, for a reader)", () => {
    expect(showsRemove(photo("a", false), false)).toBe(false);
  });

  it("is never offered on a signed entry, whatever the photo says (a page that signed the entry itself still holds the old flags)", () => {
    expect(showsRemove(photo("a", true), true)).toBe(false);
    expect(showsRemove(photo("a", false), true)).toBe(false);
  });
});

describe("removeButtonLabel and removeButtonId", () => {
  it('names the photo by its place in the list, as the picture does ("Fotka 2")', () => {
    expect(removeButtonLabel(1)).toBe("Odebrat fotografii 1");
    expect(removeButtonLabel(12)).toBe("Odebrat fotografii 12");
  });

  it("gives every photo's button an id of its own, so the focus can be put on it", () => {
    expect(removeButtonId("abc")).toBe("remove-photo-abc");
    expect(removeButtonId("abc")).not.toBe(removeButtonId("abd"));
  });

  it("says in the status what happened, in the words the page promises", () => {
    expect(REMOVED_STATUS).toBe("Fotografie odebrána");
  });
});

describe("removalFocusTarget (where the focus goes when the photo that had it is gone)", () => {
  const all = [photo("a", true), photo("b", true), photo("c", true)];

  it("goes to the button of the next photo", () => {
    expect(removalFocusTarget(all, "a", false)).toEqual({ kind: "photo", id: "b" });
    expect(removalFocusTarget(all, "b", false)).toEqual({ kind: "photo", id: "c" });
  });

  it("goes to the heading of the photos when there is no photo after it", () => {
    expect(removalFocusTarget(all, "c", false)).toEqual({ kind: "heading" });
    expect(removalFocusTarget([photo("a", true)], "a", false)).toEqual({ kind: "heading" });
  });

  it("skips a photo that has no button (somebody else's, for a worker): the next button, not a place where nothing can be pressed", () => {
    const mixed = [photo("a", true), photo("b", false), photo("c", true)];
    expect(removalFocusTarget(mixed, "a", false)).toEqual({ kind: "photo", id: "c" });
    expect(removalFocusTarget([photo("a", true), photo("b", false)], "a", false)).toEqual({ kind: "heading" });
  });

  it("goes to the heading when the entry is signed (no photo has a button then)", () => {
    expect(removalFocusTarget(all, "a", true)).toEqual({ kind: "heading" });
  });

  it("goes to the heading for a photo the list does not hold", () => {
    expect(removalFocusTarget(all, "x", false)).toEqual({ kind: "heading" });
  });
});

describe("photosFromServer (the list as the server shows it, with the names the page already knows)", () => {
  it("takes the photos in the server's order with what the server says of the right to remove them", () => {
    const list = photosFromServer(
      [
        { id: "a", canDelete: true },
        { id: "b", canDelete: false },
      ],
      [],
    );
    expect(list).toEqual([
      { id: "a", url: "/api/photos/a", canDelete: true },
      { id: "b", url: "/api/photos/b", canDelete: false },
    ]);
  });

  it('keeps the file name of a photo this page uploaded, and gives none to one it does not know (the page says "Fotka N" itself, by position)', () => {
    const list = photosFromServer(
      [
        { id: "a", canDelete: true },
        { id: "b", canDelete: true },
      ],
      [photo("b", true, "strop.jpg")],
    );
    expect(list[0].name).toBeUndefined();
    expect(list[1].name).toBe("strop.jpg");
  });

  it('takes a missing flag for "may not" (an older server, a malformed answer): a button that is not offered is safe, one that is refused is not', () => {
    expect(photosFromServer([{ id: "a" }], [])[0].canDelete).toBe(false);
    expect(photosFromServer([{ id: "a", canDelete: "yes" }], [])[0].canDelete).toBe(false);
  });

  it("ignores what is not a photo and an answer that is not a list", () => {
    expect(photosFromServer([{ id: "a", canDelete: true }, null, 3, { canDelete: true }, { id: 5 }], []).map((p) => p.id)).toEqual(["a"]);
    expect(photosFromServer(undefined, [])).toEqual([]);
    expect(photosFromServer({ id: "a" }, [])).toEqual([]);
  });
});
