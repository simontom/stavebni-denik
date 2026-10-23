import { Button } from "./Button";
import type { ButtonVariant } from "./buttonClasses";
import { useModal } from "./modalContext";

/**
 * The two buttons of a form in a [Modal] (its `footer`): "Zrušit", which cancels the way Escape does (so a dialog with typed text asks
 * before it throws the text away, and one that is saving does not move), and the one that submits the form. The form is named by
 * [formId] (`<form id=…>`): the submit button is outside it, in the footer, and says which form it belongs to.
 *
 * [busy] is an action under way (both buttons are off; the dialog itself must be `dismissible={false}` meanwhile); [canSubmit] is
 * false while the form cannot be sent yet.
 */
export function FormActions({
  formId,
  submitLabel,
  cancelLabel = "Zrušit",
  busy = false,
  canSubmit = true,
  submitVariant = "primary",
}: {
  formId: string;
  submitLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  canSubmit?: boolean;
  submitVariant?: ButtonVariant;
}) {
  const modal = useModal();
  return (
    <>
      <Button variant="secondary" disabled={busy} onClick={() => modal.cancel()}>
        {cancelLabel}
      </Button>
      <Button type="submit" form={formId} variant={submitVariant} disabled={busy || !canSubmit}>
        {submitLabel}
      </Button>
    </>
  );
}
