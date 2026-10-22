import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "danger" | "danger-quiet" | "quiet";
export type ButtonSize = "md" | "sm";

const base = "inline-flex items-center justify-center gap-2 rounded-md border font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  // The main action of a screen: white on indigo-600 is 6.3:1.
  primary: "border-transparent bg-primary text-surface hover:bg-primary-hover",
  // Any other action; the border is the boundary of the button (3:1 at least), so it is `input`, not the pale `line`.
  secondary: "border-input bg-surface text-ink hover:bg-neutral-soft",
  // An action that cannot be taken back and is the point of the screen.
  danger: "border-transparent bg-danger text-surface hover:bg-danger-hover",
  // The answer that throws something away, next to a safe one that is the primary button (a confirmation).
  "danger-quiet": "border-input bg-surface text-danger-ink hover:bg-danger-soft",
  // A text action inside a line of content, like a link that does something.
  quiet: "border-transparent bg-transparent text-primary-ink hover:bg-primary-soft",
};

// A thumb needs 44 px: every size is that high for a finger (a coarse pointer, at any width) and on any screen under `sm`. Only a
// mouse on a wide screen gets the lower button.
const sizes: Record<ButtonSize, string> = {
  md: "min-h-11 px-4 py-2 text-sm sm:pointer-fine:min-h-10",
  sm: "min-h-11 px-3 py-1.5 text-sm sm:pointer-fine:min-h-9",
};

/**
 * The classes of a button, for what is not a `<button>`: a link that looks like one
 * (`<Link to="/projects/new" className={buttonClasses({ variant: "primary" })}>`). The caller's `className` comes last and wins
 * over the button's own classes (`w-auto` over `w-full`, `px-1` over `px-4`).
 */
export function buttonClasses({
  variant = "primary",
  size = "md",
  block = false,
  className = "",
}: { variant?: ButtonVariant; size?: ButtonSize; block?: boolean; className?: string } = {}): string {
  return cn(base, variants[variant], sizes[size], block && "w-full", className);
}
