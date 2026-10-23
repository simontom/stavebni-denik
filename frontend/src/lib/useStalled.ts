import { useEffect, useState } from "react";

/** How long an action may take before the dialog that waits for it says that the server does not answer. */
export const STALLED_AFTER_MS = 20_000;

/**
 * True when [busy] (an action is under way) has lasted [after] milliseconds without an answer. A dialog that cannot be dismissed
 * while it saves would otherwise hold the person for ever when the server never answers (`api()` has no time limit: an abort could
 * lose a result the server already made, such as a new password); this is the way out. It is false again when the action ends.
 */
export function useStalled(busy: boolean, after: number = STALLED_AFTER_MS): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => setStalled(true), after);
    return () => {
      clearTimeout(timer);
      setStalled(false);
    };
  }, [busy, after]);
  return busy && stalled;
}
