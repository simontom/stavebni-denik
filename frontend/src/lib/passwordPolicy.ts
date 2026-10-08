/** The password rules, as the server enforces them (PasswordPolicy.kt); shown as a live checklist. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export interface PasswordRule {
  label: string;
  ok: boolean;
}

export function passwordRules(password: string): PasswordRule[] {
  return [
    { label: `Alespoň ${MIN_PASSWORD_LENGTH} znaků`, ok: password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH },
    { label: "Malé písmeno", ok: /[a-z]/.test(password) },
    { label: "Velké písmeno", ok: /[A-Z]/.test(password) },
    { label: "Číslice", ok: /[0-9]/.test(password) },
    { label: "Speciální znak", ok: /[^a-zA-Z0-9]/.test(password) },
  ];
}
