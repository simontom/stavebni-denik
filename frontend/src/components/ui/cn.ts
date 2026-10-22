import { twMerge } from "tailwind-merge";

export type ClassValue = string | false | null | undefined;

/**
 * Joins class names and resolves conflicts: of two classes that set the same thing (`w-full` and `w-auto`, `p-4` and `p-0`,
 * `text-base` and `text-lg`) the **later** one stays, and everything that does not conflict is kept. A shared component puts its
 * own classes first and the caller's `className` last, so `<TextInput className="w-auto" />` really is `w-auto`. Plain string
 * concatenation would leave both in the markup, and the one that wins would be the one that happens to come later in the generated
 * stylesheet, not the one the caller wrote.
 *
 * tailwind-merge takes `text-ink-muted` for a colour and `text-lg` for a size (anything that is not a size is a colour), so the
 * tokens of `index.css` need no configuration; `cn.test.ts` pins that.
 */
export function cn(...classes: ClassValue[]): string {
  return twMerge(classes.filter(Boolean).join(" "));
}
