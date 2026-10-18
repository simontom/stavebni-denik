import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

// Written out in full, so Tailwind sees every class. The ink of each tone is at least 4.5:1 on its soft background and on
// the white surface (colorTokens.test.ts), so both the filled and the outlined badge can be read.
const filled: Record<BadgeTone, string> = {
  neutral: "bg-neutral-soft text-neutral-ink",
  primary: "bg-primary-soft text-primary-ink",
  success: "bg-success-soft text-success-ink",
  warning: "bg-warning-soft text-warning-ink",
  danger: "bg-danger-soft text-danger-ink",
  info: "bg-info-soft text-info-ink",
};
const outlined: Record<BadgeTone, string> = {
  neutral: "border border-current bg-surface text-neutral-ink",
  primary: "border border-current bg-surface text-primary-ink",
  success: "border border-current bg-surface text-success-ink",
  warning: "border border-current bg-surface text-warning-ink",
  danger: "border border-current bg-surface text-danger-ink",
  info: "border border-current bg-surface text-info-ink",
};

/**
 * A short label for a state or an attribute ("Podepsáno", "Pozdní zápis"). The meaning is in the words, never in the colour
 * alone. A filled badge is a state the thing is in; an outlined one is a mark on it. A long word wraps (it must not widen the page).
 */
export function StatusBadge({
  tone = "neutral",
  outlined: isOutlined = false,
  className,
  children,
}: {
  tone?: BadgeTone;
  outlined?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex max-w-full items-center rounded px-2.5 py-1 text-xs font-semibold ${isOutlined ? outlined[tone] : filled[tone]}${className ? ` ${className}` : ""}`}
    >
      {children}
    </span>
  );
}
