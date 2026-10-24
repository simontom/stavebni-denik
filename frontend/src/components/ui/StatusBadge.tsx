import type { ReactNode } from "react";
import { badgeClassName } from "./uiClasses";

export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

/**
 * A short label for a state or an attribute ("Podepsáno", "Pozdní záznam"). The meaning is in the words, never in the colour
 * alone. A filled badge is a state the thing is in; an outlined one is a mark on it. A long word wraps (it must not widen the page).
 */
export function StatusBadge({ tone = "neutral", outlined = false, className, children }: { tone?: BadgeTone; outlined?: boolean; className?: string; children: ReactNode }) {
  return <span className={badgeClassName({ tone, outlined, className })}>{children}</span>;
}
