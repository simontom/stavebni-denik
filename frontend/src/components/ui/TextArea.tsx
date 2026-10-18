import type { ComponentProps } from "react";
import { useFieldControl } from "./fieldContext";
import { controlClasses } from "./TextInput";

export type TextAreaProps = ComponentProps<"textarea">;

/** A multi-line text field; the same look and the same ties to its [Field] as `TextInput`. */
export function TextArea({ className, rows = 3, ...rest }: TextAreaProps) {
  const field = useFieldControl();
  const describedBy = [field["aria-describedby"], rest["aria-describedby"]].filter(Boolean).join(" ") || undefined;
  return <textarea rows={rows} {...rest} {...field} aria-describedby={describedBy} className={`${controlClasses}${className ? ` ${className}` : ""}`} />;
}
