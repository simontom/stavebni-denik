"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { addAuthorizedPersonAction } from "./actions";

interface AddAuthorizedPersonDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddAuthorizedPersonDialog({
  projectId,
  open,
  onOpenChange,
}: AddAuthorizedPersonDialogProps) {
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [authorization, setAuthorization] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [isPending, startTransition] = useTransition();

  function resetForm() {
    setName("");
    setCompany("");
    setAuthorization("");
    setError(null);
  }

  function handleOpenChange(newOpen: boolean) {
    onOpenChange(newOpen);
    if (!newOpen) {
      resetForm();
    }
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    startTransition(async () => {
      const res = await addAuthorizedPersonAction({
        projectId,
        name,
        company: company || undefined,
        authorization: authorization || undefined,
      });
      if (res?.serverError) {
        setError(res.serverError);
      } else if (res?.validationErrors) {
        setError("Zkontrolujte prosím zadané údaje.");
      } else {
        handleOpenChange(false);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleCreate} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Přidat pověřenou osobu</DialogTitle>
            <DialogDescription>
              Zadejte údaje externí pověřené osoby (např. TDI, autorský dozor, geodet).
            </DialogDescription>
          </DialogHeader>

          {error && (
            <div className="text-destructive bg-destructive/10 rounded p-2 text-sm font-medium">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="person-name">Jméno a příjmení</Label>
            <Input
              id="person-name"
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="např. Ing. Arch. Petr Černý"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="person-company">Firma / Organizace</Label>
            <Input
              id="person-company"
              name="company"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="např. Architekti s.r.o."
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="person-auth">Rozsah oprávnění</Label>
            <Input
              id="person-auth"
              name="authorization"
              value={authorization}
              onChange={(e) => setAuthorization(e.target.value)}
              placeholder="např. Autorský dozor projektanta"
            />
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
              Zrušit
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
              Uložit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
