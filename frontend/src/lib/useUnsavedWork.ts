import { useEffect } from "react";
import { registerUnsavedWork, type UnsavedWorkOptions } from "./unsavedWork";

/**
 * Says, for as long as the component is on the screen and [unsaved] is true, that the page holds work that leaving would lose (typed
 * text in a dialog, a temporary password that has not been handed over, an action that is still running): a link inside the application
 * asks first, closing or reloading the tab is asked about by the browser, a lapsed session does not reload the page, and logging out says what
 * is thrown away. [options.message] says in words what leaving loses when the general question would not (it is what the leave
 * question shows). It is taken away again when the component goes away, and only this component's own registration is.
 */
export function useUnsavedWork(unsaved: boolean, options: UnsavedWorkOptions = {}): void {
  const { keptAsDraft, message } = options;
  useEffect(() => {
    if (!unsaved) return;
    return registerUnsavedWork({ keptAsDraft, message });
  }, [unsaved, keptAsDraft, message]);
}
