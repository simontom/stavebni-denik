import { removeDraft, saveDraft, type DraftScope, type StorageLike } from "./draftStore";
import type { FormValues } from "./reportForm";

export interface DraftSyncInput {
  storage: StorageLike | null;
  /** Whose draft this page keeps: the person who opened the page (fixed when it was opened, never re-read). */
  scope: DraftScope;
  /** The person signed in right now, read at this moment (another tab may have changed it); undefined when nobody is. */
  liveUserId: string | undefined;
  /** May the person write in the project: null while that is not known (the request failed or has not answered). */
  canWrite: boolean | null;
  isSigned: boolean;
  /** The form holds unsaved changes. */
  dirty: boolean;
  values: FormValues;
  /** The version of the entry the form stands on (null: the day has no entry yet). */
  updatedAt: string | null;
  /** This page has already found that it is not the signed-in person's any more: it writes nothing, for good. */
  stopped: boolean;
}

export interface DraftSyncResult {
  /** The unsaved text is on the device as a draft right now. */
  kept: boolean;
  /** Pass this back as `stopped` next time. */
  stopped: boolean;
}

/**
 * Keeps the draft of one page in step with its form, on every change. The rules:
 *  - the page belongs to the person who opened it. When somebody else is signed in now (another tab signed this person out
 *    and somebody in) or nobody is, the page's text is not theirs to keep: nothing is written or removed, and the page is
 *    `stopped` for good (even if the first person signs in again, this tab does not write any more);
 *  - while the role is not known nothing is written and nothing is removed: a failed request must not delete typed work;
 *  - for a signed entry, a role that may not write, or a form with nothing unsaved there is no draft: it is removed;
 *  - otherwise the unsaved text is written with the version it stands on.
 */
export function syncDraft(input: DraftSyncInput): DraftSyncResult {
  if (input.stopped || input.liveUserId !== input.scope.userId) return { kept: false, stopped: true };
  if (input.canWrite === null) return { kept: false, stopped: false };
  if (!input.canWrite || input.isSigned || !input.dirty) {
    removeDraft(input.storage, input.scope);
    return { kept: false, stopped: false };
  }
  return { kept: saveDraft(input.storage, input.scope, { baseUpdatedAt: input.updatedAt, values: input.values }), stopped: false };
}
