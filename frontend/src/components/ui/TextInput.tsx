import type { ComponentProps } from "react";
import { useFieldControl } from "./fieldContext";

/**
 * The look of every text control (input, textarea, select): a boundary that can be seen (`border-input`, 3:1 at least), text
 * of 16 px on a phone (iOS zooms into anything smaller), 14 px from `sm` up, and a red border when the field is marked invalid.
 */
export const controlClasses =
  "block w-full rounded-md border border-input bg-surface px-3 py-2 text-base text-ink placeholder:text-ink-muted sm:text-sm " +
  "disabled:bg-neutral-soft disabled:text-ink-muted aria-invalid:border-danger";

export type TextInputProps = ComponentProps<"input">;

/**
 * A single-line input. Inside a [Field] it takes the field's `id`, `aria-describedby` and `aria-invalid` (the field's `id`
 * wins over one given here). `min-h-11`: a thumb needs 44 px.
 */
export function TextInput({ className, ...rest }: TextInputProps) {
  const field = useFieldControl();
  const describedBy = [field["aria-describedby"], rest["aria-describedby"]].filter(Boolean).join(" ") || undefined;
  return <input {...rest} {...field} aria-describedby={describedBy} className={`${controlClasses} min-h-11 sm:min-h-10${className ? ` ${className}` : ""}`} />;
}
