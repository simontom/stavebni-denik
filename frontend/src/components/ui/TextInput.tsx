import type { ComponentProps } from "react";
import { useFieldControl } from "./fieldContext";
import { controlClassName } from "./uiClasses";

export type TextInputProps = ComponentProps<"input">;

/**
 * A single-line input. Inside a [Field] it takes the field's `id`, `aria-describedby` and `aria-invalid` (the field's `id`
 * wins over one given here). 44 px high for a finger; a `className` given here wins over the input's own classes.
 */
export function TextInput({ className, ...rest }: TextInputProps) {
  const field = useFieldControl();
  const describedBy = [field["aria-describedby"], rest["aria-describedby"]].filter(Boolean).join(" ") || undefined;
  return <input {...rest} {...field} aria-describedby={describedBy} className={controlClassName(className, true)} />;
}
