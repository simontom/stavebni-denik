"use client";

import { useState, useTransition } from "react";
import { Pencil, Plus, UserCheck, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/dates";

import { revokeAuthorizedPersonAction } from "./actions";
import { AddAuthorizedPersonDialog } from "./AddAuthorizedPersonDialog";
import {
  EditAuthorizedPersonDialog,
  type AuthorizedPersonItem,
} from "./EditAuthorizedPersonDialog";

export type { AuthorizedPersonItem };

interface Props {
  projectId: string;
  persons: AuthorizedPersonItem[];
  canManage: boolean;
}

export function AuthorizedPersonsPanel({ projectId, persons, canManage }: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [editingPerson, setEditingPerson] = useState<AuthorizedPersonItem | null>(null);

  const [isPending, startTransition] = useTransition();

  function handleRevoke(personId: string, personName: string) {
    if (
      !window.confirm(
        `Opravdu chcete zrušit pověření pro osobu: ${personName}? Tato akce je nevratná.`,
      )
    ) {
      return;
    }
    startTransition(() => {
      void revokeAuthorizedPersonAction({ personId, projectId });
    });
  }

  return (
    <Card className="mt-6">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base">Seznam pověřených osob</CardTitle>
          <p className="text-muted-foreground mt-1 text-xs">
            Osoby oprávněné provádět záznamy v deníku dle § 157 stavebního zákona
          </p>
        </div>
        {canManage && (
          <>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="mr-1 size-4" aria-hidden /> Přidat osobu
            </Button>
            <AddAuthorizedPersonDialog
              projectId={projectId}
              open={addOpen}
              onOpenChange={setAddOpen}
            />
          </>
        )}
      </CardHeader>
      <CardContent>
        {persons.length === 0 ? (
          <p className="text-muted-foreground text-sm">Žádné pověřené osoby.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {persons.map((p) => {
              const isRevoked = Boolean(p.revokedAt);
              const isSystemUser = Boolean(p.linkedUserId);

              return (
                <Card
                  key={p.id}
                  className={`flex flex-col justify-between gap-3 p-4 ${
                    isRevoked ? "bg-muted/30 opacity-60" : ""
                  }`}
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div
                        className={`text-base font-semibold ${
                          isRevoked ? "text-muted-foreground line-through" : ""
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
                          <Badge variant="secondary" className="flex items-center gap-1 text-xs">
                            <UserCheck className="size-3" aria-hidden />
                            Uživatel
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-green-300 text-xs text-green-700"
                          >
                            Aktivní
                          </Badge>
                        )}
                      </div>
                    </div>

                    {p.authorization && (
                      <div className="text-muted-foreground text-sm font-medium">
                        {p.authorization}
                      </div>
                    )}

                    {p.company && (
                      <div className="text-muted-foreground text-xs">Organizace: {p.company}</div>
                    )}
                  </div>

                  <div className="text-muted-foreground mt-2 flex items-center justify-between border-t pt-2 text-xs">
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
                            onClick={() => setEditingPerson(p)}
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
        {canManage && (
          <EditAuthorizedPersonDialog
            projectId={projectId}
            person={editingPerson}
            onClose={() => setEditingPerson(null)}
          />
        )}
      </CardContent>
    </Card>
  );
}
