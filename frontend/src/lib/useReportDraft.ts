import { useEffect, useRef, useState } from "react";
import { currentUser, setUnsavedWork } from "./api";
import { browserStorage, loadDraft, removeDraft, type Draft } from "./draftStore";
import { syncDraft } from "./draftSync";
import { decideDraft, parseFormValues, type FormValues } from "./reportForm";

export interface ReportDraftInput {
  /**
   * The person, project and day of the page; null while any of them is unknown (nothing is read or written then). The
   * person is the one who opened the page, fixed when it was opened: never read it again from the browser's storage,
   * where another tab may have signed somebody else in since.
   */
  scope: { userId: string; projectId: string; day: string } | null;
  /** The entry (or the answer that the day has none) has arrived. */
  ready: boolean;
  /** The entry as the server shows it, as form values: what a draft is compared with. */
  loaded: FormValues | null;
  /** May the person write in the project; null while that is not known (the request failed or has not answered). */
  canWrite: boolean | null;
  isSigned: boolean;
  /** The form differs from the state it was loaded or last saved in. */
  dirty: boolean;
  /** What the form holds. Keep the object as it is between edits (the draft is written when it changes). */
  values: FormValues;
  /** The version of the entry the form stands on (null: the day has no entry yet). */
  updatedAt: string | null;
}

export interface ReportDraft {
  /** A draft is waiting for the person's answer (the form stays locked until they give it). */
  offer: { savedAt: Date; stale: boolean } | null;
  /** The person takes the draft: returns its values, for the page to put into the form. */
  restore: () => FormValues | null;
  /** The person throws the draft away. */
  discard: () => void;
}

/** The id of the person signed in right now, or undefined; a blocked storage (it throws) reads as nobody. */
function signedInUserId(): string | undefined {
  try {
    return currentUser()?.id;
  } catch {
    return undefined;
  }
}

type Verdict = "unjudged" | "settled" | { draft: Draft<FormValues>; stale: boolean };

/**
 * The draft of one day (backlog B2; the rules are in `draftStore.ts`, `decideDraft` and `syncDraft`), and what the
 * application is told about unsaved work (`setUnsavedWork`: the leave question, the session dialog):
 *  1. when the day has been opened (entry and role known) the stored draft is judged: offered (`offer`) when it holds what
 *     the stored entry does not; a draft of a signed entry, of somebody who may not write, or identical to the entry is
 *     never offered and goes. While the role is not known nothing is judged and nothing is removed;
 *  2. from then on, while the form holds unsaved changes the draft follows every change; with none (saved, or the changes
 *     undone) there is no draft; for a signed entry or a role that cannot write there is never one.
 * Every storage access is guarded, so the page works without storage; the application is then told that the text is not kept
 * as a draft (leaving would lose it).
 */
export function useReportDraft(input: ReportDraftInput): ReportDraft {
  const { scope, ready, loaded, canWrite, isSigned, dirty, values, updatedAt } = input;
  const userId = scope?.userId ?? null;
  const projectId = scope?.projectId ?? null;
  const day = scope?.day ?? null;

  const [verdict, setVerdict] = useState<Verdict>("unjudged");
  // This page found that the person signed in is not the one who opened it: it writes nothing from then on.
  const stopped = useRef(false);

  // Judged once, in the render in which the entry and the role have both arrived (React's way to derive state from what
  // arrived: the page renders again at once, before anything is shown, so a locked form is never seen unlocked).
  if (verdict === "unjudged" && ready && loaded !== null && canWrite !== null) {
    if (userId === null || projectId === null || day === null) {
      setVerdict("settled");
    } else {
      const stored = loadDraft(browserStorage(), { userId, projectId, day }, parseFormValues);
      const decision = decideDraft({ draft: stored, loaded, loadedUpdatedAt: updatedAt, canWrite, isSigned });
      setVerdict(decision.action === "offer" && stored ? { draft: stored, stale: decision.stale } : "settled");
    }
  }
  // The entry became signed while a draft waited: whatever the person answers, unsigned text must not end up in a signed
  // form, so the offer goes (the effect below removes the draft).
  if (typeof verdict === "object" && isSigned) setVerdict("settled");

  // Follows the form. A draft that is dropped (identical to the entry, a signed entry, a role that cannot write) is
  // removed here, because none of those has unsaved changes to keep.
  useEffect(() => {
    if (verdict !== "settled") return;
    let kept = false;
    if (userId !== null && projectId !== null && day !== null) {
      const result = syncDraft({
        storage: browserStorage(),
        scope: { userId, projectId, day },
        liveUserId: signedInUserId(),
        canWrite,
        isSigned,
        dirty,
        values,
        updatedAt,
        stopped: stopped.current,
      });
      stopped.current = result.stopped;
      kept = result.kept;
    }
    setUnsavedWork(dirty, kept);
  }, [verdict, userId, projectId, day, canWrite, isSigned, dirty, values, updatedAt]);

  useEffect(() => () => setUnsavedWork(false), []);

  return {
    offer: typeof verdict === "object" ? { savedAt: new Date(verdict.draft.savedAt), stale: verdict.stale } : null,
    restore: () => {
      if (typeof verdict !== "object") return null;
      setVerdict("settled");
      return verdict.draft.values;
    },
    discard: () => {
      if (userId !== null && projectId !== null && day !== null) removeDraft(browserStorage(), { userId, projectId, day });
      setVerdict("settled");
    },
  };
}
