import type { ReactNode } from "react";

/**
 * What a page shows when it has no content to show: it is loading, it failed, or there is nothing yet. One look and one
 * way of announcing it (`role="status"` for loading and for empty, `role="alert"` for an error), so a screen reader hears it.
 * [children] is the sentence, [action] a button or link that gets the person out of the state ("Zkusit znovu", "Přidat projekt").
 */
export function PageState({ kind, children, action }: { kind: "loading" | "error" | "empty"; children?: ReactNode; action?: ReactNode }) {
  const words = children ?? (kind === "loading" ? "Načítání…" : kind === "error" ? "Něco se nepovedlo." : "Zatím tu nic není.");
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`px-4 py-10 text-center text-sm ${kind === "error" ? "text-danger-ink" : "text-ink-muted"}`}>
      <p>{words}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
