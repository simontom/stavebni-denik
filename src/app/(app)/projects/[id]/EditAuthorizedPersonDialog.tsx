"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { updateAuthorizedPersonAction } from "./actions";

export interface AuthorizedPersonItem {
  id: string;
  name: string;
  company?: string | null;
  authorization?: string | null;
  linkedUserId?: string | null;
  revokedAt?: Date | string | null;
  createdAt: Date | string;
}

interface EditAuthorizedPersonDialogProps {
  projectId: string;
  person: AuthorizedPersonItem | null;
  onClose: () => void;
}

function EditAuthorizedPersonForm({
  projectId,
  person,
  onClose,
}: {
  projectId: string;
  person: AuthorizedPersonItem;
  onClose: () => void;
}) {
  const [name, setName] = useState(person.name);
  const [company, setCompany] = useState(person.company ?? "");
  const [authorization, setAuthorization] = useState(person.authorization ?? "");
  const [error, setError] = useState<string | null>(null);

  const [isPending, startTransition] = useTransition();

  function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const fd = new FormData();
    fd.append("name", name);
    fd.append("company", company);
    fd.append("authorization", authorization);

    startTransition(async () => {
      const res = await updateAuthorizedPersonAction(person.id, projectId, fd);
      if (res.error) {
        setError(res.error);
      } else {
        onClose();
      }
    });
  }

  return (
    <form onSubmit={handleUpdate} className="space-y-4">
      <DialogHeader>
        <DialogTitle>Upravit pověřenou osobu</DialogTitle>
      </DialogHeader>

      {error && (
        <div className="text-destructive bg-destructive/10 rounded p-2 text-sm font-medium">
          {error}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="edit-person-name">Jméno a příjmení</Label>
        <Input
          id="edit-person-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="edit-person-company">Firma / Organizace</Label>
        <Input
          id="edit-person-company"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="edit-person-auth">Rozsah oprávnění</Label>
        <Input
          id="edit-person-auth"
          value={authorization}
          onChange={(e) => setAuthorization(e.target.value)}
        />
      </div>

      <DialogFooter className="pt-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Zrušit
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
          Uložit změny
        </Button>
      </DialogFooter>
    </form>
  );
}

export function EditAuthorizedPersonDialog({
  projectId,
  person,
  onClose,
}: EditAuthorizedPersonDialogProps) {
  return (
    <Dialog open={Boolean(person)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        {person && (
          <EditAuthorizedPersonForm
            key={person.id}
            projectId={projectId}
            person={person}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
