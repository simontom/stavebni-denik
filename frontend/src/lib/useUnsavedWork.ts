import { useEffect } from "react";
import { setUnsavedWork } from "./api";

/**
 * Says, for as long as the component is on the screen, whether the page holds work that would be lost by leaving it (typed text
 * in a dialog, a temporary password that has not been handed over): a link inside the application then asks first, a lapsed
 * session does not reload the page, and logging out says what is thrown away. It is off again when the component goes away.
 */
export function useUnsavedWork(unsaved: boolean, keptAsDraft = false): void {
  useEffect(() => {
    setUnsavedWork(unsaved, keptAsDraft);
    return () => setUnsavedWork(false);
  }, [unsaved, keptAsDraft]);
}
