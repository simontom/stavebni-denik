"use client";

import { useActionState, useState } from "react";
import { Check, Copy, Loader2, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { createUserAction, type CreateUserState } from "./actions";

const ROLE_OPTIONS: Array<{ value: "BOSS" | "WORKER" | "GUEST"; label: string }> = [
  { value: "WORKER", label: "Pracovník" },
  { value: "GUEST", label: "Dozor / TDS" },
  { value: "BOSS", label: "Stavbyvedoucí" },
];

export function CreateUserDialog() {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<"BOSS" | "WORKER" | "GUEST">("WORKER");
  const [state, formAction, isPending] = useActionState<
    CreateUserState | undefined,
    FormData
  >(createUserAction, undefined);
  const [passwordCopied, setPasswordCopied] = useState(false);

  const created = state?.status === "ok" ? state.result : null;
  const fieldErrors =
    state?.status === "field-error" ? state.fieldErrors : undefined;

  function handleCopyPassword() {
    if (!created) return;
    navigator.clipboard
      .writeText(created.generatedPassword)
      .then(() => {
        setPasswordCopied(true);
        toast.success("Heslo zkopírováno do schránky.");
      })
      .catch(() => toast.error("Zkopírování se nezdařilo."));
  }

  function handleOpenChange(next: boolean) {
    if (next === false && created) {
      // Make absolutely sure the user knows the password won't be shown again.
      const confirmed = window.confirm(
        "Heslo se po zavření okna už nikdy znovu nezobrazí. Opravdu zavřít?",
      );
      if (!confirmed) return;
    }
    // Reset transient UI state whenever the dialog opens. The action
    // state is preserved between submits to surface validation errors.
    if (next) setPasswordCopied(false);
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button>
            <UserPlus className="size-4" aria-hidden /> Nový uživatel
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Uživatel vytvořen</DialogTitle>
              <DialogDescription>
                Předejte tyto údaje uživateli {created.displayName} bezpečným
                kanálem (osobně, šifrovaná zpráva). <strong>Heslo se nikdy nezobrazí
                znovu.</strong>
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              <div className="grid gap-1">
                <Label className="text-xs uppercase text-muted-foreground">
                  Přihlašovací jméno
                </Label>
                <Input
                  readOnly
                  value={created.nickname}
                  className="font-mono"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
              <div className="grid gap-1">
                <Label className="text-xs uppercase text-muted-foreground">
                  Heslo
                </Label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={created.generatedPassword}
                    className="font-mono"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCopyPassword}
                    aria-label="Zkopírovat heslo"
                  >
                    {passwordCopied ? (
                      <Check className="size-4" aria-hidden />
                    ) : (
                      <Copy className="size-4" aria-hidden />
                    )}
                  </Button>
                </div>
              </div>
              <Alert>
                <AlertDescription className="text-xs">
                  Uživatel bude při prvním přihlášení automaticky vyzván k
                  nastavení vlastního hesla.
                </AlertDescription>
              </Alert>
            </div>

            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>Hotovo</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Nový uživatel</DialogTitle>
              <DialogDescription>
                Vyplňte přihlašovací jméno a roli. Systém vygeneruje silné heslo.
              </DialogDescription>
            </DialogHeader>

            <form action={formAction} className="flex flex-col gap-4" noValidate>
              {state?.status === "nickname-in-use" && (
                <Alert variant="destructive">
                  <AlertDescription>
                    Toto přihlašovací jméno je již obsazené.
                  </AlertDescription>
                </Alert>
              )}
              {state?.status === "forbidden" && (
                <Alert variant="destructive">
                  <AlertDescription>
                    Nemáte oprávnění vytvářet uživatele.
                  </AlertDescription>
                </Alert>
              )}
              {state?.status === "error" && (
                <Alert variant="destructive">
                  <AlertDescription>{state.message}</AlertDescription>
                </Alert>
              )}

              <div className="grid gap-2">
                <Label htmlFor="nickname">Přihlašovací jméno</Label>
                <Input
                  id="nickname"
                  name="nickname"
                  required
                  minLength={3}
                  maxLength={64}
                  autoCapitalize="off"
                  autoComplete="off"
                  spellCheck={false}
                  pattern="[a-z0-9._\-]+"
                  aria-invalid={!!fieldErrors?.nickname}
                  placeholder="napr. honza.novak"
                />
                {fieldErrors?.nickname && (
                  <p className="text-sm text-destructive">{fieldErrors.nickname}</p>
                )}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="displayName">Jméno a příjmení</Label>
                <Input
                  id="displayName"
                  name="displayName"
                  required
                  maxLength={128}
                  aria-invalid={!!fieldErrors?.displayName}
                  placeholder="Jan Novák"
                />
                {fieldErrors?.displayName && (
                  <p className="text-sm text-destructive">
                    {fieldErrors.displayName}
                  </p>
                )}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="role">Role</Label>
                <Select
                  value={role}
                  onValueChange={(v) =>
                    setRole(v as "BOSS" | "WORKER" | "GUEST")
                  }
                >
                  <SelectTrigger id="role">
                    <SelectValue>
                      {(value) =>
                        ROLE_OPTIONS.find((o) => o.value === value)?.label ??
                        value
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* Select is uncontrolled w.r.t. FormData; we forward the
                    current value via a hidden input so the server action
                    sees it. */}
                <input type="hidden" name="role" value={role} />
                {fieldErrors?.role && (
                  <p className="text-sm text-destructive">{fieldErrors.role}</p>
                )}
              </div>

              {role === "BOSS" && (
                <div className="grid gap-2">
                  <Label htmlFor="ckaitNumber">
                    Číslo autorizace ČKAIT{" "}
                    <span className="text-muted-foreground">
                      (povinné pro stavbyvedoucího — § 153 stavebního zákona)
                    </span>
                  </Label>
                  <Input
                    id="ckaitNumber"
                    name="ckaitNumber"
                    maxLength={32}
                    autoComplete="off"
                    placeholder="napr. 0123456"
                  />
                </div>
              )}

              <div className="grid gap-2">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="isAdmin"
                    value="true"
                    className="mt-1 size-4"
                  />
                  <span>
                    <span className="font-medium">Administrátor aplikace</span>
                    <br />
                    <span className="text-xs text-muted-foreground">
                      Spravuje uživatele a čte audit log. Není nutné, aby byl
                      zároveň stavbyvedoucí.
                    </span>
                  </span>
                </label>
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                >
                  Zrušit
                </Button>
                <Button type="submit" disabled={isPending}>
                  {isPending && (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  )}
                  Vytvořit
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
