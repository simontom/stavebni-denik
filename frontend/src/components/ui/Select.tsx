import type { ComponentProps } from "react";
import { useFieldControl } from "./fieldContext";
import { controlClassName } from "./uiClasses";

export type SelectProps = ComponentProps<"select">;

/**
 * A native `<select>` (the browser's own list: it works from the keyboard, with a screen reader and with the picker of a
 * phone, which a custom dropdown does not). The same look and ties to its [Field] as `TextInput`.
 */
export function Select({ className, ...rest }: SelectProps) {
  const field = useFieldControl();
  const describedBy = [field["aria-describedby"], rest["aria-describedby"]].filter(Boolean).join(" ") || undefined;
  return <select {...rest} {...field} aria-describedby={describedBy} className={controlClassName(className, true)} />;
}
