import { useId, type ReactNode } from "react";
import { FieldContext } from "./fieldContext";

/**
 * A labelled form control: the label is tied to the control (`htmlFor` and `id`), the hint and the error are tied to it
 * with `aria-describedby`, and the error is announced when it appears (`role="alert"`) and marks the control invalid.
 *
 *     <Field label="Přihlašovací jméno" hint="Jméno, které vám dal správce" error={problem}>
 *       <TextInput name="nickname" value={v} onChange={…} />
 *     </Field>
 *
 * [labelHidden] keeps the label for screen readers only, where the design has no room for it (it is still the control's name).
 * The hint is above the control, between the label and it; with [hintBelow] it is under the control (a note about the list of a
 * select that would push the control down, such as why some of its options cannot be chosen); either way it describes the control.
 * An error is announced when it appears: `role="alert"` (assertive), or with [errorRole] `"status"` (polite) for a mistake that may still
 * mend itself while the person types, so the screen reader does not interrupt them. The control's `id` is made up; pass [id] when something else has to name it (a test, a link that points at the field).
 */
export function Field({
  id: given,
  label,
  hint,
  hintBelow = false,
  error,
  errorRole = "alert",
  labelHidden = false,
  className,
  children,
}: {
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  hintBelow?: boolean;
  error?: ReactNode;
  errorRole?: "alert" | "status";
  labelHidden?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const generated = useId();
  const id = given ?? generated;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className={labelHidden ? "sr-only" : "mb-1 block text-sm font-medium text-ink"}>
        {label}
      </label>
      {hint && !hintBelow && (
        <p id={hintId} className="mb-1 text-sm text-ink-muted">
          {hint}
        </p>
      )}
      <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error) }}>{children}</FieldContext.Provider>
      {hint && hintBelow && (
        <p id={hintId} className="mt-1 text-sm text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role={errorRole} className="mt-1 text-sm font-medium text-danger-ink">
          {error}
        </p>
      )}
    </div>
  );
}
