import { describe, expect, it } from "vitest";
import { draftKey, loadDraft, saveDraft, type DraftScope } from "./draftStore";
import { syncDraft, type DraftSyncInput } from "./draftSync";
import { emptyForm, parseFormValues, type FormValues } from "./reportForm";
import { MemoryStorage } from "./testStorage";

const scopeOfA: DraftScope = { userId: "user-a", projectId: "project-1", day: "2026-10-16" };
const scopeOfB: DraftScope = { ...scopeOfA, userId: "user-b" };
const typed = (text: string): FormValues => ({ ...emptyForm(), workDescription: text });
const read = (storage: MemoryStorage, scope: DraftScope) => loadDraft(storage, scope, parseFormValues);

/** What the page passes on every change: A is signed in, may write, the entry is not signed, and the form has unsaved text. */
const input = (storage: MemoryStorage, over: Partial<DraftSyncInput> = {}): DraftSyncInput => ({
  storage,
  scope: scopeOfA,
  liveUserId: "user-a",
  canWrite: true,
  isSigned: false,
  dirty: true,
  values: typed("Betonáž, jména: Jan Novák"),
  updatedAt: "v1",
  stopped: false,
  ...over,
});

describe("syncDraft, which keeps the draft in step with the form", () => {
  it("writes the draft of unsaved text for the person who is signed in, with the version it stands on", () => {
    const storage = new MemoryStorage();
    expect(syncDraft(input(storage))).toEqual({ kept: true, stopped: false });
    const draft = read(storage, scopeOfA);
    expect(draft?.values.workDescription).toBe("Betonáž, jména: Jan Novák");
    expect(draft?.baseUpdatedAt).toBe("v1");
  });

  it("follows every change, and removes the draft when there is nothing unsaved any more (saved, or the changes undone)", () => {
    const storage = new MemoryStorage();
    syncDraft(input(storage));
    syncDraft(input(storage, { values: typed("Betonáž, doplněno") }));
    expect(read(storage, scopeOfA)?.values.workDescription).toBe("Betonáž, doplněno");

    expect(syncDraft(input(storage, { dirty: false }))).toEqual({ kept: false, stopped: false });
    expect(read(storage, scopeOfA)).toBeNull();
  });

  it("never keeps a draft of a signed entry or of a role that is known not to write: it removes one that is there", () => {
    const storage = new MemoryStorage();
    syncDraft(input(storage));
    expect(syncDraft(input(storage, { isSigned: true })).kept).toBe(false);
    expect(read(storage, scopeOfA)).toBeNull();

    syncDraft(input(storage));
    expect(syncDraft(input(storage, { canWrite: false })).kept).toBe(false);
    expect(read(storage, scopeOfA)).toBeNull();
  });

  it("neither writes nor removes while the role is not known: a failed request must not delete a draft", () => {
    const storage = new MemoryStorage();
    saveDraft(storage, scopeOfA, { baseUpdatedAt: "v1", values: typed("rozepsané před výpadkem spojení") });

    expect(syncDraft(input(storage, { canWrite: null, dirty: false }))).toEqual({ kept: false, stopped: false });
    expect(syncDraft(input(storage, { canWrite: null, dirty: true, values: typed("jiný text") }))).toEqual({ kept: false, stopped: false });

    expect(read(storage, scopeOfA)?.values.workDescription).toBe("rozepsané před výpadkem spojení");
  });

  it("does not write A's text under B's key when another tab has signed A out and B in, and stops for good", () => {
    const storage = new MemoryStorage();
    syncDraft(input(storage));
    expect(read(storage, scopeOfA)).not.toBeNull();

    // In another tab A logged out (all drafts cleared) and B logged in; this tab still holds A's unsaved text.
    storage.items.clear();
    const result = syncDraft(input(storage, { liveUserId: "user-b", values: typed("A's text with workers' names") }));

    expect(result).toEqual({ kept: false, stopped: true });
    expect([...storage.items.keys()]).toEqual([]);
    expect(storage.items.has(draftKey(scopeOfB))).toBe(false);
  });

  it("stops when nobody is signed in, and leaves other drafts untouched", () => {
    const storage = new MemoryStorage();
    saveDraft(storage, scopeOfA, { baseUpdatedAt: "v1", values: typed("kept") });
    expect(syncDraft(input(storage, { liveUserId: undefined, dirty: false }))).toEqual({ kept: false, stopped: true });
    expect(read(storage, scopeOfA)?.values.workDescription).toBe("kept");
  });

  it("stays stopped even if A signs in again later: this tab no longer writes", () => {
    const storage = new MemoryStorage();
    expect(syncDraft(input(storage, { stopped: true }))).toEqual({ kept: false, stopped: true });
    expect(storage.items.size).toBe(0);
  });

  it("says the text is not kept when the storage refuses the write, and does not stop", () => {
    const storage = new MemoryStorage();
    storage.failing = "write";
    expect(syncDraft(input(storage))).toEqual({ kept: false, stopped: false });
  });

  it("works with no storage at all", () => {
    expect(syncDraft({ ...input(new MemoryStorage()), storage: null })).toEqual({ kept: false, stopped: false });
  });
});
