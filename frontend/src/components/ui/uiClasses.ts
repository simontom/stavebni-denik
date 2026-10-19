import { cn } from "./cn";
import type { BadgeTone } from "./StatusBadge";
import type { BannerTone } from "./Banner";

/**
 * The class lists of the shared components, as plain functions (so a unit test can see them without a DOM). Every one of them
 * puts its own classes first and the caller's `className` last, through `cn`, so the caller's class wins.
 *
 * "Coarse" and "fine" are the pointer: a finger (a phone, a tablet, in any orientation and at any width) or a mouse. A finger
 * gets 44 px targets and 16 px text everywhere; a mouse gets the denser look from `sm` (640 px) up. Width alone is not the test:
 * a phone held sideways is wider than 640 px.
 */

/** The look of every text control (input, textarea, select): a boundary that can be seen (3:1 at least), 16 px text for a finger, a red border when invalid. */
export const controlClasses =
  "block w-full rounded-md border border-input bg-surface px-3 py-2 text-base text-ink placeholder:text-ink-muted sm:pointer-fine:text-sm " +
  "disabled:bg-neutral-soft disabled:text-ink-muted aria-invalid:border-danger";

/** [singleLine]: an input or a select, which a thumb has to hit (44 px); a textarea is as tall as its rows. */
export function controlClassName(className?: string, singleLine = false): string {
  return cn(controlClasses, singleLine && "min-h-11 sm:pointer-fine:min-h-10", className);
}

export function cardClassName({ compact = false, className }: { compact?: boolean; className?: string }): string {
  return cn("rounded-lg border border-line bg-surface shadow-sm", compact ? "p-4" : "p-4 sm:p-6", className);
}

// Written out in full, so Tailwind sees every class. The ink of each tone is at least 4.5:1 on its soft background and on the
// white surface (colorTokens.test.ts), so both the filled and the outlined badge can be read.
const badgeFilled: Record<BadgeTone, string> = {
  neutral: "bg-neutral-soft text-neutral-ink",
  primary: "bg-primary-soft text-primary-ink",
  success: "bg-success-soft text-success-ink",
  warning: "bg-warning-soft text-warning-ink",
  danger: "bg-danger-soft text-danger-ink",
  info: "bg-info-soft text-info-ink",
};
const badgeOutlined: Record<BadgeTone, string> = {
  neutral: "border border-current bg-surface text-neutral-ink",
  primary: "border border-current bg-surface text-primary-ink",
  success: "border border-current bg-surface text-success-ink",
  warning: "border border-current bg-surface text-warning-ink",
  danger: "border border-current bg-surface text-danger-ink",
  info: "border border-current bg-surface text-info-ink",
};

export function badgeClassName({ tone, outlined, className }: { tone: BadgeTone; outlined: boolean; className?: string }): string {
  return cn("inline-flex max-w-full items-center rounded px-2.5 py-1 text-xs font-semibold", outlined ? badgeOutlined[tone] : badgeFilled[tone], className);
}

const bannerTones: Record<BannerTone, string> = {
  info: "border-info bg-info-soft text-info-ink",
  success: "border-success bg-success-soft text-success-ink",
  warning: "border-warning bg-warning-soft text-warning-ink",
  danger: "border-danger bg-danger-soft text-danger-ink",
};

export function bannerClassName({ tone, className }: { tone: BannerTone; className?: string }): string {
  return cn("rounded-md border-l-4 p-3 text-sm", bannerTones[tone], className);
}

/**
 * A tab. On a phone every tab is a bordered button in a grid, and the current one is told apart by more than colour (WCAG 1.4.1):
 * it is bold and underlined, like the current page in the header. From `sm` up the row of tabs has a line under the current one.
 */
export function tabLinkClassName({ active, className }: { active: boolean; className?: string }): string {
  return cn(
    "flex min-h-11 items-center justify-center rounded-md border px-3 text-center text-sm sm:min-h-0 sm:rounded-none sm:border-0 sm:border-b-2 sm:px-1 sm:pt-0 sm:pb-4",
    active
      ? "border-primary bg-primary-soft font-semibold text-primary-ink underline decoration-2 underline-offset-4 sm:bg-transparent sm:no-underline"
      : "border-input font-medium text-ink-muted hover:bg-neutral-soft hover:text-ink sm:border-transparent sm:hover:border-input sm:hover:bg-transparent",
    className,
  );
}
