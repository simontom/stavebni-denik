"use client";

import { useState, useTransition } from "react";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";

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

import { updateUserAction, type UpdateUserState } from "./actions";

type Role = "BOSS" | "WORKER" | "INSPECTOR" | "INVESTOR";

const ROLE_OPTIONS: Array<{ value: Role; label: string }> = [
  { value: "WORKER", label: "Pracovník" },
  { value: "INSPECTOR", label: "Dozor / TDS" },
  { value: "BOSS", label: "Stavbyvedoucí" },
];

interface Props {
  userId: string;
  /** Stávající hodnoty pro pre-fill. Component je controlled pro
   *  role + isAdmin, ostatní pole jsou uncontrolled defaultValue. */
  initialValues: {
    nickname: string;
    displayName: string;
    role: Role;
    ckaitNumber: string | null;
    isAdmin: boolean;
  };
}

/**
 * Dialog pro úpravu existujícího uživatele. Nickname je IMMUTABLE
 * (zobrazený readonly pro orientaci, do form data ho neposíláme —
 * server ho čte z `userId`). Heslo se tudy nemění (separate flow).
 */
export function EditUserDialog({ userId, initialValues }: Props) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>(initialValues.role);
  const [isAdmin, setIsAdmin] = useState<boolean>(initialValues.isAdmin);
  const [state, setState] = useState<UpdateUserState | undefined>(undefined);
  const [isPending, startTransition] = useTransition();

  const fieldErrors = state?.status === "field-error" ? state.fieldErrors : undefined;

  function handleOpenChange(next: boolean) {
    if (next) {
      setRole(initialValues.role);
      setIsAdmin(initialValues.isAdmin);
      setState(undefined);
    } else {
      setState(undefined);
    }
    setOpen(next);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const res = await updateUserAction(undefined, formData);
      if (res.status === "ok") {
        toast.success(`${initialValues.displayName} aktualizován.`);
        setOpen(false);
        setState(undefined);
      } else {
        setState(res);
        if (res.status === "forbidden") {
          toast.error("Nemáte oprávnění (přihlaste se znovu jako admin).");
        } else if (res.status === "not-found") {
          toast.error("Uživatel nebyl nalezen.");
        } else if (res.status === "last-admin") {
          toast.error("Nelze odebrat poslednímu adminovi flag — aplikace by zůstala bez správce.");
        } else if (res.status === "error") {
          toast.error(res.message);
        }
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Upravit účet ${initialValues.displayName}`}
          >
            <Pencil className="size-4" aria-hidden />
            <span>Upravit</span>
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upravit uživatele</DialogTitle>
          <DialogDescription>
            Změňte jméno, roli, ČKAIT nebo admin flag. Přihlašovací jméno a heslo se zde nemění.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <input type="hidden" name="userId" value={userId} />

          <div className="grid gap-2">
            <Label>Přihlašovací jméno</Label>
            <p className="text-muted-foreground font-mono text-sm">{initialValues.nickname}</p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor={`displayName-${userId}`}>Jméno a příjmení</Label>
            <Input
              id={`displayName-${userId}`}
              name="displayName"
              defaultValue={initialValues.displayName}
              maxLength={128}
              required
              aria-invalid={!!fieldErrors?.displayName}
            />
            {fieldErrors?.displayName && (
              <p className="text-destructive text-sm">{fieldErrors.displayName}</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor={`role-${userId}`}>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger id={`role-${userId}`}>
                <SelectValue>
                  {(value) => ROLE_OPTIONS.find((o) => o.value === value)?.label ?? value}
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
            <input type="hidden" name="role" value={role} />
          </div>

          {role === "BOSS" && (
            <div className="grid gap-2">
              <Label htmlFor={`ckaitNumber-${userId}`}>
                Číslo autorizace ČKAIT{" "}
                <span className="text-muted-foreground">
                  (povinné pro stavbyvedoucího — § 153 stavebního zákona)
                </span>
              </Label>
              <Input
                id={`ckaitNumber-${userId}`}
                name="ckaitNumber"
                defaultValue={initialValues.ckaitNumber ?? ""}
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
                checked={isAdmin}
                onChange={(e) => setIsAdmin(e.target.checked)}
                className="mt-1 size-4"
              />
              <span>
                <span className="font-medium">Administrátor aplikace</span>
                <br />
                <span className="text-muted-foreground text-xs">
                  Spravuje uživatele a čte audit log. Není nutné, aby byl zároveň stavbyvedoucí.
                </span>
              </span>
            </label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Zrušit
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Uložit změny
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
