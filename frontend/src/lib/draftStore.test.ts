import { describe, expect, it } from "vitest";
import {
  DRAFT_MAX_AGE_DAYS,
  browserStorage,
  clearAllDrafts,
  clearDraftsExceptUser,
  draftKey,
  isStorageUsable,
  loadDraft,
  pruneDrafts,
  removeDraft,
  saveDraft,
  type DraftScope,
  type StorageLike,
} from "./draftStore";

/** localStorage in memory; `failing` makes every access throw, as a blocked or full storage does. */
class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  failing: "none" | "all" | "write" = "none";

  get length(): number {
    if (this.failing === "all") throw new Error("storage blocked");
    return this.items.size;
  }
  key(index: number): string | null {
    if (this.failing === "all") throw new Error("storage blocked");
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    if (this.failing === "all") throw new Error("storage blocked");
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failing !== "none") throw new Error("QuotaExceededError");
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    if (this.failing === "all") throw new Error("storage blocked");
    this.items.delete(key);
  }
}

interface Text {
  text: string;
}
const parseText = (raw: unknown): Text | null => (typeof raw === "object" && raw !== null && typeof (raw as Text).text === "string" ? { text: (raw as Text).text } : null);

const scope: DraftScope = { userId: "user-1", projectId: "project-1", day: "2026-10-16" };
const NOW = new Date("2026-10-17T10:00:00Z");
const daysAgo = (days: number, from: Date = NOW): Date => new Date(from.getTime() - days * 24 * 60 * 60 * 1000);

describe("a draft kept on the device", () => {
  it("is saved and loaded back with its scope, the version it was typed on and the time", () => {
    const storage = new MemoryStorage();
    expect(saveDraft(storage, scope, { baseUpdatedAt: "2026-10-16T08:00:00Z", values: { text: "Betonáž" } }, NOW)).toBe(true);

    const draft = loadDraft(storage, scope, parseText);
    expect(draft).toEqual({ version: 1, ...scope, baseUpdatedAt: "2026-10-16T08:00:00Z", savedAt: NOW.toISOString(), values: { text: "Betonáž" } });
  });

  it("remembers that the day had no entry when it was typed (no base version)", () => {
    const storage = new MemoryStorage();
    saveDraft(storage, scope, { baseUpdatedAt: null, values: { text: "x" } }, NOW);
    expect(loadDraft(storage, scope, parseText)?.baseUpdatedAt).toBeNull();
  });

  it("is kept per user, project and day, and writing one never touches another", () => {
    const storage = new MemoryStorage();
    const other: DraftScope[] = [
      { ...scope, userId: "user-2" },
      { ...scope, projectId: "project-2" },
      { ...scope, day: "2026-10-15" },
    ];
    saveDraft(storage, scope, { baseUpdatedAt: null, values: { text: "mine" } }, NOW);
    other.forEach((s, i) => saveDraft(storage, s, { baseUpdatedAt: null, values: { text: `other ${i}` } }, NOW));

    expect(loadDraft(storage, scope, parseText)?.values.text).toBe("mine");
    other.forEach((s, i) => expect(loadDraft(storage, s, parseText)?.values.text).toBe(`other ${i}`));
    expect(new Set([scope, ...other].map(draftKey)).size).toBe(4);
  });

  it("is never read by somebody else, even if the stored text was moved to another key", () => {
    const storage = new MemoryStorage();
    saveDraft(storage, scope, { baseUpdatedAt: null, values: { text: "names of workers" } }, NOW);
    const intruder: DraftScope = { ...scope, userId: "user-2" };
    expect(loadDraft(storage, intruder, parseText)).toBeNull();

    // The stored text says whose it is: copying it under another person's key does not hand it over, and the copy is removed.
    storage.items.set(draftKey(intruder), storage.items.get(draftKey(scope))!);
    expect(loadDraft(storage, intruder, parseText)).toBeNull();
    expect(storage.items.has(draftKey(intruder))).toBe(false);
    expect(loadDraft(storage, scope, parseText)?.values.text).toBe("names of workers");
  });

  it.each([
    ["not JSON", "{oops"],
    ["not an object", JSON.stringify(["a"])],
    ["another version", JSON.stringify({ version: 2, ...scope, baseUpdatedAt: null, savedAt: NOW.toISOString(), values: { text: "x" } })],
    ["a missing time", JSON.stringify({ version: 1, ...scope, baseUpdatedAt: null, values: { text: "x" } })],
    ["a time that is no date", JSON.stringify({ version: 1, ...scope, baseUpdatedAt: null, savedAt: "yesterday", values: { text: "x" } })],
    ["a base version that is a number", JSON.stringify({ version: 1, ...scope, baseUpdatedAt: 5, savedAt: NOW.toISOString(), values: { text: "x" } })],
    ["values the form cannot read", JSON.stringify({ version: 1, ...scope, baseUpdatedAt: null, savedAt: NOW.toISOString(), values: { text: 7 } })],
  ])("is refused and removed when what was stored is damaged: %s", (_name, stored) => {
    const storage = new MemoryStorage();
    storage.items.set(draftKey(scope), stored);
    expect(loadDraft(storage, scope, parseText)).toBeNull();
    expect(storage.items.has(draftKey(scope))).toBe(false);
  });

  it("is removed on its own, leaving the others", () => {
    const storage = new MemoryStorage();
    const next: DraftScope = { ...scope, day: "2026-10-17" };
    saveDraft(storage, scope, { baseUpdatedAt: null, values: { text: "a" } }, NOW);
    saveDraft(storage, next, { baseUpdatedAt: null, values: { text: "b" } }, NOW);

    removeDraft(storage, scope);

    expect(loadDraft(storage, scope, parseText)).toBeNull();
    expect(loadDraft(storage, next, parseText)?.values.text).toBe("b");
  });

  it("reports that it could not be written, and keeps what was there before", () => {
    const storage = new MemoryStorage();
    saveDraft(storage, scope, { baseUpdatedAt: null, values: { text: "old" } }, NOW);
    storage.failing = "write";

    expect(saveDraft(storage, scope, { baseUpdatedAt: null, values: { text: "new" } }, NOW)).toBe(false);
    storage.failing = "none";
    expect(loadDraft(storage, scope, parseText)?.values.text).toBe("old");
  });
});

describe("clearing drafts", () => {
  const fill = () => {
    const storage = new MemoryStorage();
    storage.items.set("user", JSON.stringify({ id: "user-1" }));
    storage.items.set("something-else", "keep");
    saveDraft(storage, scope, { baseUpdatedAt: null, values: { text: "1" } }, NOW);
    saveDraft(storage, { ...scope, day: "2026-10-15" }, { baseUpdatedAt: null, values: { text: "2" } }, NOW);
    saveDraft(storage, { ...scope, userId: "user-2" }, { baseUpdatedAt: null, values: { text: "3" } }, NOW);
    return storage;
  };
  const draftKeys = (storage: MemoryStorage) => [...storage.items.keys()].filter((k) => k.startsWith("denik:draft:"));

  it("clearAllDrafts removes every draft of every user and nothing else (a logout)", () => {
    const storage = fill();
    expect(clearAllDrafts(storage)).toBe(3);
    expect(draftKeys(storage)).toEqual([]);
    expect([...storage.items.keys()].sort()).toEqual(["something-else", "user"]);
  });

  it("clearDraftsExceptUser keeps the drafts of the person who signed in and removes the others", () => {
    const storage = fill();
    expect(clearDraftsExceptUser(storage, "user-1")).toBe(1);
    expect(draftKeys(storage)).toHaveLength(2);
    expect(loadDraft(storage, { ...scope, userId: "user-2" }, parseText)).toBeNull();
    expect(loadDraft(storage, scope, parseText)?.values.text).toBe("1");
  });

  it("does not mix up user ids where one is the beginning of another", () => {
    const storage = new MemoryStorage();
    saveDraft(storage, { ...scope, userId: "user-1" }, { baseUpdatedAt: null, values: { text: "short id" } }, NOW);
    saveDraft(storage, { ...scope, userId: "user-12" }, { baseUpdatedAt: null, values: { text: "long id" } }, NOW);
    clearDraftsExceptUser(storage, "user-1");
    expect(loadDraft(storage, { ...scope, userId: "user-1" }, parseText)?.values.text).toBe("short id");
    expect(loadDraft(storage, { ...scope, userId: "user-12" }, parseText)).toBeNull();
  });
});

describe("pruning when the application starts", () => {
  it("drops drafts older than 30 days, keeps newer ones (30 days exactly stays)", () => {
    expect(DRAFT_MAX_AGE_DAYS).toBe(30);
    const storage = new MemoryStorage();
    const day = (n: number): DraftScope => ({ ...scope, day: `2026-09-${String(n).padStart(2, "0")}` });
    saveDraft(storage, day(1), { baseUpdatedAt: null, values: { text: "31 days" } }, daysAgo(31));
    saveDraft(storage, day(2), { baseUpdatedAt: null, values: { text: "30 days" } }, daysAgo(30));
    saveDraft(storage, day(3), { baseUpdatedAt: null, values: { text: "1 day" } }, daysAgo(1));
    saveDraft(storage, day(4), { baseUpdatedAt: null, values: { text: "just now" } }, NOW);

    expect(pruneDrafts(storage, { now: NOW, signedInUserId: "user-1" })).toBe(1);

    expect(loadDraft(storage, day(1), parseText)).toBeNull();
    expect(loadDraft(storage, day(2), parseText)?.values.text).toBe("30 days");
    expect(loadDraft(storage, day(3), parseText)?.values.text).toBe("1 day");
    expect(loadDraft(storage, day(4), parseText)?.values.text).toBe("just now");
  });

  it("drops what cannot be read and ignores keys that are not drafts", () => {
    const storage = new MemoryStorage();
    storage.items.set(draftKey(scope), "garbage");
    storage.items.set("user", JSON.stringify({ id: "user-1" }));
    pruneDrafts(storage, { now: NOW, signedInUserId: "user-1" });
    expect(storage.items.has(draftKey(scope))).toBe(false);
    expect(storage.items.has("user")).toBe(true);
  });

  it("drops the drafts of everybody else, and all of them when nobody is signed in", () => {
    const storage = new MemoryStorage();
    saveDraft(storage, scope, { baseUpdatedAt: null, values: { text: "mine" } }, NOW);
    saveDraft(storage, { ...scope, userId: "user-2" }, { baseUpdatedAt: null, values: { text: "theirs" } }, NOW);

    pruneDrafts(storage, { now: NOW, signedInUserId: "user-1" });
    expect(loadDraft(storage, scope, parseText)?.values.text).toBe("mine");
    expect(loadDraft(storage, { ...scope, userId: "user-2" }, parseText)).toBeNull();

    pruneDrafts(storage, { now: NOW, signedInUserId: null });
    expect(loadDraft(storage, scope, parseText)).toBeNull();
  });
});

describe("a storage that does not work", () => {
  it("never makes any operation throw: the page has to work without it", () => {
    const storage = new MemoryStorage();
    saveDraft(storage, scope, { baseUpdatedAt: null, values: { text: "x" } }, NOW);
    storage.failing = "all";

    expect(saveDraft(storage, scope, { baseUpdatedAt: null, values: { text: "y" } }, NOW)).toBe(false);
    expect(loadDraft(storage, scope, parseText)).toBeNull();
    expect(() => removeDraft(storage, scope)).not.toThrow();
    expect(clearAllDrafts(storage)).toBe(0);
    expect(clearDraftsExceptUser(storage, "user-1")).toBe(0);
    expect(pruneDrafts(storage, { now: NOW, signedInUserId: "user-1" })).toBe(0);
    expect(isStorageUsable(storage)).toBe(false);
  });

  it("is also fine with no storage at all (null)", () => {
    expect(saveDraft(null, scope, { baseUpdatedAt: null, values: { text: "x" } }, NOW)).toBe(false);
    expect(loadDraft(null, scope, parseText)).toBeNull();
    expect(() => removeDraft(null, scope)).not.toThrow();
    expect(clearAllDrafts(null)).toBe(0);
    expect(clearDraftsExceptUser(null, "user-1")).toBe(0);
    expect(pruneDrafts(null, { now: NOW, signedInUserId: null })).toBe(0);
    expect(isStorageUsable(null)).toBe(false);
  });

  it("is usable when it works, and the probe leaves nothing behind", () => {
    const storage = new MemoryStorage();
    expect(isStorageUsable(storage)).toBe(true);
    expect(storage.items.size).toBe(0);
  });

  it("browserStorage gives null where there is no window, or where reaching localStorage throws", () => {
    expect(browserStorage()).toBeNull(); // the unit tests run in Node: no window

    const original = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      get localStorage(): Storage {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    };
    try {
      expect(browserStorage()).toBeNull();
    } finally {
      if (original === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = original;
    }
  });
});
