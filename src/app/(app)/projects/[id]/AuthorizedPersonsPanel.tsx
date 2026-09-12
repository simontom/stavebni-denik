"use client";

import { useState, useTransition } from "react";
import {
  Loader2,
  Pencil,
  Plus,
  UserCheck,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { formatDate } from "@/lib/dates";

import {
  addAuthorizedPersonAction,
  revokeAuthorizedPersonAction,
  updateAuthorizedPersonAction,
} from "./actions";

export interface AuthorizedPersonItem {
  id: string;
  name: string;
  company?: string | null;
  authorization?: string | null;
  linkedUserId?: string | null;
  revokedAt?: Date | string | null;
  createdAt: Date | string;
}

interface Props {
  projectId: string;
  persons: AuthorizedPersonItem[];
  canManage: boolean;
}

export function AuthorizedPersonsPanel({
  projectId,
  persons,
  canManage,
}: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [editingPerson, setEditingPerson] = useState<AuthorizedPersonItem | null>(
    null,
  );

  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [authorization, setAuthorization] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [isPending, startTransition] = useTransition();

  function handleOpenAdd() {
    setName("");
    setCompany("");
    setAuthorization("");
    setError(null);
    setAddOpen(true);
  }

  function handleOpenEdit(p: AuthorizedPersonItem) {
    setEditingPerson(p);
    setName(p.name);
    setCompany(p.company ?? "");
    setAuthorization(p.authorization ?? "");
    setError(null);
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const fd = new FormData();
    fd.append("name", name);
    fd.append("company", company);
    fd.append("authorization", authorization);

    startTransition(async () => {
      const res = await addAuthorizedPersonAction(projectId, fd);
      if (res.error) {
        setError(res.error);
      } else {
        setAddOpen(false);
      }
    });
  }

  function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (!editingPerson) return;
    setError(null);
    const fd = new FormData();
    fd.append("name", name);
    fd.append("company", company);
    fd.append("authorization", authorization);

    startTransition(async () => {
      const res = await updateAuthorizedPersonAction(
        editingPerson.id,
        projectId,
        fd,
      );
      if (res.error) {
        setError(res.error);
      } else {
        setEditingPerson(null);
      }
    });
  }

  function handleRevoke(personId: string, personName: string) {
    if (
      !window.confirm(
        `Opravdu chcete zrušit pověření pro osobu: ${personName}? Tato akce je nevratná.`,
      )
    ) {
      return;
    }
    startTransition(() => {
      void revokeAuthorizedPersonAction(personId, projectId);
    });
  }

  return (
    <Card className="mt-6">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base">Seznam pověřených osob</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Osoby oprávněné provádět záznamy v deníku dle § 157 stavebního zákona
          </p>
        </div>
        {canManage && (
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger
              render={
                <Button size="sm" onClick={handleOpenAdd}>
                  <Plus className="size-4 mr-1" aria-hidden /> Přidat osobu
                </Button>
              }
            />
            <DialogContent className="sm:max-w-md">
              <form onSubmit={handleCreate} className="space-y-4">
                <DialogHeader>
                  <DialogTitle>Přidat pověřenou osobu</DialogTitle>
                  <DialogDescription>
                    Zadejte údaje externí pověřené osoby (např. TDI, autorský
                    dozor, geodet).
                  </DialogDescription>
                </DialogHeader>

                {error && (
                  <div className="text-sm font-medium text-destructive bg-destructive/10 p-2 rounded">
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
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setAddOpen(false)}
                  >
                    Zrušit
                  </Button>
                  <Button type="submit" disabled={isPending}>
                    {isPending && (
                      <Loader2 className="size-4 mr-2 animate-spin" aria-hidden />
                    )}
                    Uložit
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </CardHeader>
      <CardContent>
        {persons.length === 0 ? (
          <p className="text-sm text-muted-foreground">Žádné pověřené osoby.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {persons.map((p) => {
              const isRevoked = Boolean(p.revokedAt);
              const isSystemUser = Boolean(p.linkedUserId);

              return (
                <Card
                  key={p.id}
                  className={`p-4 flex flex-col justify-between gap-3 ${
                    isRevoked ? "opacity-60 bg-muted/30" : ""
                  }`}
                >
                  <div className="space-y-2">
                    <div className="flex justify-between items-start gap-2">
                      <div
                        className={`font-semibold text-base ${
                          isRevoked ? "line-through text-muted-foreground" : ""
                        }`}
                      >
                        {p.name}
                      </div>
                      <div>
                        {isRevoked ? (
                          <Badge variant="destructive" className="text-xs">
                            Zrušeno
                          </Badge>
                        ) : isSystemUser ? (
                          <Badge
                            variant="secondary"
                            className="text-xs flex items-center gap-1"
                          >
                            <UserCheck className="size-3" aria-hidden />
                            Uživatel
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="text-xs text-green-700 border-green-300"
                          >
                            Aktivní
                          </Badge>
                        )}
                      </div>
                    </div>

                    {p.authorization && (
                      <div className="text-sm text-muted-foreground font-medium">
                        {p.authorization}
                      </div>
                    )}

                    {p.company && (
                      <div className="text-xs text-muted-foreground">
                        Organizace: {p.company}
                      </div>
                    )}
                  </div>

                  <div className="border-t pt-2 mt-2 flex items-center justify-between text-xs text-muted-foreground">
                    <div>
                      {isRevoked ? (
                        <span className="text-destructive font-medium">
                          Zrušeno: {formatDate(p.revokedAt!)}
                        </span>
                      ) : (
                        <span>Zapsáno: {formatDate(p.createdAt)}</span>
                      )}
                    </div>

                    {canManage && !isRevoked && (
                      <div className="flex items-center gap-1">
                        {!isSystemUser && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => handleOpenEdit(p)}
                            aria-label={`Upravit ${p.name}`}
                          >
                            <Pencil className="size-3.5" aria-hidden />
                          </Button>
                        )}
                        {!isSystemUser && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => handleRevoke(p.id, p.name)}
                            disabled={isPending}
                            aria-label={`Zrušit ${p.name}`}
                            className="text-destructive hover:text-destructive"
                          >
                            <XCircle className="size-3.5" aria-hidden />
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        {/* Edit Dialog */}
        {editingPerson && (
          <Dialog
            open={Boolean(editingPerson)}
            onOpenChange={(v) => !v && setEditingPerson(null)}
          >
            <DialogContent className="sm:max-w-md">
              <form onSubmit={handleUpdate} className="space-y-4">
                <DialogHeader>
                  <DialogTitle>Upravit pověřenou osobu</DialogTitle>
                </DialogHeader>

                {error && (
                  <div className="text-sm font-medium text-destructive bg-destructive/10 p-2 rounded">
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
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setEditingPerson(null)}
                  >
                    Zrušit
                  </Button>
                  <Button type="submit" disabled={isPending}>
                    {isPending && (
                      <Loader2 className="size-4 mr-2 animate-spin" aria-hidden />
                    )}
                    Uložit změny
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
}
