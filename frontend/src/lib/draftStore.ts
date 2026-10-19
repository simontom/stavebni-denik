/**
 * Drafts of daily entries kept on this device (backlog B2), so that a phone that kills the tab while the camera is open,
 * a lapsed session or a mis-tap does not lose what was typed.
 *
 * A draft holds personal data (the names of the people on site), so:
 *  - it is keyed by the user, the project and the day, and it says whose it is: it is never read for somebody else;
 *  - it is removed on logout, when somebody else signs in, when it is saved, and when it is older than 30 days (at start);
 *  - every access to `localStorage` is guarded: a blocked, full or missing storage never breaks the page, the draft is
 *    simply not kept.
 *
 * Nothing here knows what the values are: the caller supplies the parser that checks them, so this module is plain
 * logic that the unit tests drive with an in-memory storage.
 */

/** The part of `Storage` used here (and what an in-memory test double has to offer). */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What a draft belongs to: one person's work on one day of one project. */
export interface DraftScope {
  userId: string;
  projectId: string;
  /** The day of the entry, `YYYY-MM-DD`. */
  day: string;
}

export interface Draft<T> extends DraftScope {
  version: 1;
  /** The `updatedAt` of the entry this was typed on top of; null when the day had no entry yet. */
  baseUpdatedAt: string | null;
  /** When the draft was written (ISO time of this device's clock). */
  savedAt: string;
  values: T;
}

export const DRAFT_PREFIX = "denik:draft:v1:";

/** Drafts older than this are dropped when the application starts. */
export const DRAFT_MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const part = (value: string): string => encodeURIComponent(value);

/** The storage key of a draft: the prefix, then user, project and day (each encoded, so a `:` cannot blur the parts). */
export const draftKey = (scope: DraftScope): string => `${DRAFT_PREFIX}${part(scope.userId)}:${part(scope.projectId)}:${part(scope.day)}`;

const keyBelongsToUser = (key: string, userId: string): boolean => key.startsWith(`${DRAFT_PREFIX}${part(userId)}:`);

/** `window.localStorage`, or null where there is none (a unit test) or the browser refuses it (a blocked-storage setting throws). */
export function browserStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether the storage accepts a write right now (a private window or a full disk may not). Leaves nothing behind. */
export function isStorageUsable(storage: StorageLike | null = browserStorage()): boolean {
  if (!storage) return false;
  const probe = `${DRAFT_PREFIX}probe`;
  try {
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** The keys of every draft in the storage (collected first, so removing while going through them is safe). */
function draftKeys(storage: StorageLike): string[] {
  const keys: string[] = [];
  const count = storage.length;
  for (let i = 0; i < count; i++) {
    const key = storage.key(i);
    if (key !== null && key.startsWith(DRAFT_PREFIX)) keys.push(key);
  }
  return keys;
}

/** Writes the draft; false when it could not be (the page works on without it). The draft that was there stays. */
export function saveDraft<T>(storage: StorageLike | null, scope: DraftScope, draft: { baseUpdatedAt: string | null; values: T }, now: Date = new Date()): boolean {
  if (!storage) return false;
  try {
    const stored: Draft<T> = {
      version: 1,
      userId: scope.userId,
      projectId: scope.projectId,
      day: scope.day,
      baseUpdatedAt: draft.baseUpdatedAt,
      savedAt: now.toISOString(),
      values: draft.values,
    };
    storage.setItem(draftKey(scope), JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the draft of [scope]; null when there is none. What is stored is checked (its shape, that it belongs to this scope
 * and that [parseValues] accepts the values); a damaged or foreign draft is removed and reads as none.
 */
export function loadDraft<T>(storage: StorageLike | null, scope: DraftScope, parseValues: (raw: unknown) => T | null): Draft<T> | null {
  if (!storage) return null;
  try {
    const key = draftKey(scope);
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const draft = parseDraft(raw, parseValues);
    if (draft === null || draft.userId !== scope.userId || draft.projectId !== scope.projectId || draft.day !== scope.day) {
      removeDraft(storage, scope);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

function parseDraft<T>(raw: string, parseValues: (raw: unknown) => T | null): Draft<T> | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.version !== 1) return null;
  if (typeof d.userId !== "string" || typeof d.projectId !== "string" || typeof d.day !== "string") return null;
  if (d.baseUpdatedAt !== null && typeof d.baseUpdatedAt !== "string") return null;
  if (typeof d.savedAt !== "string" || Number.isNaN(Date.parse(d.savedAt))) return null;
  const values = parseValues(d.values);
  if (values === null) return null;
  return { version: 1, userId: d.userId, projectId: d.projectId, day: d.day, baseUpdatedAt: d.baseUpdatedAt, savedAt: d.savedAt, values };
}

/** Removes the draft of [scope] (saved, discarded, or not allowed to exist). */
export function removeDraft(storage: StorageLike | null, scope: DraftScope): void {
  if (!storage) return;
  try {
    storage.removeItem(draftKey(scope));
  } catch {
    // nothing to do: the storage does not work
  }
}

function removeKeys(storage: StorageLike, keys: string[]): number {
  let removed = 0;
  for (const key of keys) {
    try {
      storage.removeItem(key);
      removed++;
    } catch {
      // the storage stopped working: the rest cannot be removed either
    }
  }
  return removed;
}

/** Removes every draft of every user (a logout). Returns how many were removed. */
export function clearAllDrafts(storage: StorageLike | null = browserStorage()): number {
  if (!storage) return 0;
  try {
    return removeKeys(storage, draftKeys(storage));
  } catch {
    return 0;
  }
}

/** Removes the drafts of everybody but [userId] (somebody else signed in on this device). Returns how many were removed. */
export function clearDraftsExceptUser(storage: StorageLike | null, userId: string): number {
  if (!storage) return 0;
  try {
    return removeKeys(
      storage,
      draftKeys(storage).filter((key) => !keyBelongsToUser(key, userId)),
    );
  } catch {
    return 0;
  }
}

/**
 * How far ahead of this device's clock a draft may be dated and still be believed (the clock may have been corrected since
 * it was written). Dated later than that, it cannot be told how old it is: it would never expire, so it goes.
 */
export const DRAFT_MAX_FUTURE_SKEW_MS = DAY_MS;

/**
 * Housekeeping when the application starts: removes drafts that are older than [DRAFT_MAX_AGE_DAYS] days (exactly that
 * old stays), dated in the future (beyond [DRAFT_MAX_FUTURE_SKEW_MS]), or that cannot be read; and, when somebody is signed
 * in, those of anybody else. When nobody is signed in it removes nothing else: the login page forgets who was signed in
 * without a logout, and the same person who signs in again (or somebody else, whose sign-in clears the rest) decides what
 * happens to the drafts. Returns how many were removed.
 */
export function pruneDrafts(storage: StorageLike | null, options: { now?: Date; signedInUserId: string | null }): number {
  if (!storage) return 0;
  try {
    const now = (options.now ?? new Date()).getTime();
    const doomed = draftKeys(storage).filter((key) => {
      if (options.signedInUserId !== null && !keyBelongsToUser(key, options.signedInUserId)) return true;
      const draft = parseDraft(storage.getItem(key) ?? "", (values) => values);
      if (draft === null) return true;
      const savedAt = Date.parse(draft.savedAt);
      return now - savedAt > DRAFT_MAX_AGE_DAYS * DAY_MS || savedAt - now > DRAFT_MAX_FUTURE_SKEW_MS;
    });
    return removeKeys(storage, doomed);
  } catch {
    return 0;
  }
}
