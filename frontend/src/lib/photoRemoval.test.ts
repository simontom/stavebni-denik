import { describe, expect, it } from "vitest";
import {
  REMOVED_STATUS,
  mergeServerPhotos,
  photosFromServer,
  removalFocusTarget,
  removeButtonId,
  removeButtonLabel,
  removePhotoOnServer,
  showsRemove,
  type PhotoItem,
} from "./photoRemoval";

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

describe("mergeServerPhotos (a list read earlier must not take back a photo that is gone, nor lose one that arrived meanwhile)", () => {
  it("takes the server's photos in its order and keeps what the page shows that the answer lacks (a photo that arrived while the answer was on its way)", () => {
    const merged = mergeServerPhotos(
      [
        { id: "a", canDelete: true },
        { id: "b", canDelete: false },
      ],
      [photo("b", true, "b.jpg"), photo("new", true, "new.jpg")],
      new Set(),
    );
    expect(merged.map((p) => p.id)).toEqual(["a", "b", "new"]);
    expect(merged[1]).toMatchObject({ name: "b.jpg", canDelete: false });
    expect(merged[2]).toMatchObject({ name: "new.jpg", canDelete: true });
  });

  it("leaves out a photo that is known to be gone, in the answer (a read that began before the removal) and on the page alike", () => {
    const merged = mergeServerPhotos(
      [
        { id: "a", canDelete: true },
        { id: "gone", canDelete: true },
      ],
      [photo("a", true), photo("gone", true), photo("kept", true)],
      new Set(["gone"]),
    );
    expect(merged.map((p) => p.id)).toEqual(["a", "kept"]);
  });

  it("is the list of the server when the page knew nothing and nothing is gone", () => {
    expect(mergeServerPhotos([{ id: "a", canDelete: true }], [], new Set()).map((p) => p.id)).toEqual(["a"]);
    expect(
      mergeServerPhotos(undefined, [photo("a", true)], new Set()).map((p) => p.id),
      "an answer that is not a list changes nothing the page holds",
    ).toEqual(["a"]);
  });
});

describe("removePhotoOnServer (what the question's yes does)", () => {
  const answer = (status: number, body: unknown = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });
  const readError = async (res: Response, fallback: string) => ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? fallback;
  function setup(...results: (Response | Error)[]) {
    let outOfDate = 0;
    const deps = {
      send: async () => {
        const next = results.shift();
        if (next instanceof Error) throw next;
        return next ?? answer(204);
      },
      noAnswer: new Set<string>(),
      gone: new Set<string>(),
      onOutOfDate: () => {
        outOfDate++;
      },
      readError,
    };
    return { deps, outOfDate: () => outOfDate };
  }

  it("is done when the server says so: the photo is gone, and the page need not read the entry again", async () => {
    const { deps, outOfDate } = setup(answer(204));
    await expect(removePhotoOnServer("a", deps)).resolves.toBeUndefined();
    expect(deps.gone.has("a")).toBe(true);
    expect(outOfDate()).toBe(0);
  });

  it("says in words that the connection failed, and that the photo may be gone all the same", async () => {
    const { deps } = setup(new TypeError("Failed to fetch"));
    await expect(removePhotoOnServer("a", deps)).rejects.toThrow(/Spojení se serverem se přerušilo/);
    expect(deps.noAnswer.has("a"), "it is remembered that this removal got no answer").toBe(true);
    expect(deps.gone.has("a"), "the photo is not taken for gone: nobody knows").toBe(false);
  });

  it("takes a 404 for success when the removal of THAT photo had got no answer: the server did remove it, only its answer was lost", async () => {
    const { deps, outOfDate } = setup(new TypeError("Failed to fetch"), answer(404, { error: "Fotografie nenalezena" }));
    await expect(removePhotoOnServer("a", deps)).rejects.toThrow(/Spojení/);
    await expect(removePhotoOnServer("a", deps), "the second try finds nothing, and that is the answer").resolves.toBeUndefined();
    expect(deps.gone.has("a")).toBe(true);
    expect(deps.noAnswer.has("a"), "and the doubt is over").toBe(false);
    expect(outOfDate(), "nothing to read again: the page knows what happened").toBe(0);
  });

  it("keeps a plain 404 a refusal with the server's words, reads the entry again, and drops the photo it is about from every later list", async () => {
    const { deps, outOfDate } = setup(answer(404, { error: "Fotografie nenalezena" }));
    await expect(removePhotoOnServer("a", deps)).rejects.toThrow("Fotografie nenalezena");
    expect(outOfDate()).toBe(1);
    expect(deps.gone.has("a")).toBe(true);
  });

  it("does not take a 404 for success when the lost answer was another photo's", async () => {
    const { deps, outOfDate } = setup(new TypeError("Failed to fetch"), answer(404, { error: "Fotografie nenalezena" }));
    await expect(removePhotoOnServer("a", deps)).rejects.toThrow(/Spojení/);
    await expect(removePhotoOnServer("b", deps)).rejects.toThrow("Fotografie nenalezena");
    expect(outOfDate()).toBe(1);
    expect(deps.noAnswer.has("a"), "photo a is still in doubt").toBe(true);
  });

  it("keeps a 409 (the entry was signed) and a 403 refusals even after a lost answer, and reads the entry again", async () => {
    for (const status of [409, 403]) {
      const { deps, outOfDate } = setup(new TypeError("Failed to fetch"), answer(status, { error: "Z podepsaného záznamu nelze fotografii odebrat." }));
      await expect(removePhotoOnServer("a", deps)).rejects.toThrow(/Spojení/);
      await expect(removePhotoOnServer("a", deps)).rejects.toThrow(/podepsaného/);
      expect(outOfDate(), `status ${status}`).toBe(1);
      expect(deps.gone.has("a"), "a photo that is still there is not gone").toBe(false);
    }
  });

  it("gives the page's own words when the server sends none, and does not read the entry again for a failure that says nothing of its state", async () => {
    const { deps, outOfDate } = setup(new Response("<html>oops</html>", { status: 500 }));
    await expect(removePhotoOnServer("a", deps)).rejects.toThrow("Fotografii se nepodařilo odebrat");
    expect(outOfDate()).toBe(0);
  });

  it("lets an error that is not a lost connection through as it is (an ended session says so itself)", async () => {
    const { deps } = setup(new Error("Přihlášení vypršelo."));
    await expect(removePhotoOnServer("a", deps)).rejects.toThrow("Přihlášení vypršelo.");
    expect(deps.noAnswer.has("a"), "the request did not go out as far as anybody knows").toBe(false);
  });
});
