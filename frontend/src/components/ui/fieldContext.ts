import { createContext, useContext } from "react";

/** What a control needs from the field around it, so the label, the hint and the error are tied to it for assistive technology. */
export interface FieldControl {
  id: string;
  /** The ids of the hint and of the error, as `aria-describedby` takes them. */
  describedBy: string | undefined;
  invalid: boolean;
}

export const FieldContext = createContext<FieldControl | null>(null);

/**
 * The attributes a control gets from its [Field] (none outside one). `TextInput`, `TextArea` and `Select` call this; a
 * custom control can too and spread what it returns.
 */
export function useFieldControl(): { id?: string; "aria-describedby"?: string; "aria-invalid"?: true } {
  const field = useContext(FieldContext);
  if (!field) return {};
  return { id: field.id, "aria-describedby": field.describedBy, ...(field.invalid ? { "aria-invalid": true as const } : {}) };
}
