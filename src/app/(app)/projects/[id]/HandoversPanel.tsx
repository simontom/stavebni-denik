"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, FileSignature, Loader2, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/dates";

import { deleteHandoverAction, signHandoverAction } from "./actions";
import { CreateHandoverDialog, type MeterState } from "./CreateHandoverDialog";

export interface HandoverItem {
  id: string;
  type: string;
  date: Date | string;
  participants: string;
  meterStates: MeterState[] | unknown;
  notes?: string | null;
  signedAt?: Date | string | null;
}

interface Props {
  projectId: string;
  handovers: HandoverItem[];
  canManage: boolean;
}

export function HandoversPanel({ projectId, handovers, canManage }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSign(handoverId: string) {
    if (
      !window.confirm("Opravdu chcete podepsat tento předávací protokol? Tato akce je nevratná.")
    ) {
      return;
    }
    startTransition(() => {
      void signHandoverAction(handoverId, projectId);
    });
  }

  function handleDelete(handoverId: string) {
    if (!window.confirm("Opravdu chcete smazat tento předávací protokol?")) {
      return;
    }
    startTransition(() => {
      void deleteHandoverAction(handoverId, projectId);
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Záznamy o předání staveniště</CardTitle>
        {canManage && (
          <>
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="mr-1 size-4" aria-hidden /> Přidat předání
            </Button>
            <CreateHandoverDialog projectId={projectId} open={open} onOpenChange={setOpen} />
          </>
        )}
      </CardHeader>
      <CardContent>
        {handovers.length === 0 ? (
          <p className="text-muted-foreground text-sm">Žádné záznamy o předání.</p>
        ) : (
          <div className="grid gap-4">
            {handovers.map((h) => {
              const metersList: MeterState[] = Array.isArray(h.meterStates)
                ? (h.meterStates as MeterState[])
                : [];
              return (
                <Card key={h.id} className="flex flex-col gap-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h4 className="text-base font-semibold">{h.type}</h4>
                      <p className="text-muted-foreground text-xs">Datum: {formatDate(h.date)}</p>
                    </div>
                    <div>
                      {h.signedAt ? (
                        <Badge
                          variant="outline"
                          className="flex items-center gap-1 border-green-300 text-green-600"
                        >
                          <CheckCircle2 className="size-3" aria-hidden />
                          Podepsáno dne {formatDate(h.signedAt)}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Čeká na podpis</Badge>
                      )}
                    </div>
                  </div>

                  <div className="text-sm">
                    <span className="text-muted-foreground font-medium">Účastníci: </span>
                    <span>{h.participants}</span>
                  </div>

                  {metersList.length > 0 && (
                    <div className="bg-muted/40 rounded border p-2 text-xs">
                      <div className="text-muted-foreground mb-1 font-medium">Stavy měřidel:</div>
                      <div className="grid gap-1">
                        {metersList.map((m, mi) => (
                          <div
                            key={mi}
                            className="flex justify-between border-b py-0.5 last:border-0"
                          >
                            <span className="font-medium">{m.name}</span>
                            {m.number && (
                              <span className="text-muted-foreground">č. {m.number}</span>
                            )}
                            <span className="font-mono">{m.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {h.notes && (
                    <div className="text-muted-foreground bg-accent/20 rounded p-2 text-sm">
                      {h.notes}
                    </div>
                  )}

                  {canManage && (
                    <div className="mt-1 flex items-center justify-end gap-2 border-t pt-2">
                      {!h.signedAt && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isPending}
                          onClick={() => handleSign(h.id)}
                        >
                          <FileSignature className="mr-1 size-4" aria-hidden />
                          Podepsat předání
                        </Button>
                      )}
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={isPending}
                        onClick={() => handleDelete(h.id)}
                        aria-label="Smazat předání"
                      >
                        {isPending ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden />
                        ) : (
                          <Trash2 className="text-destructive size-4" aria-hidden />
                        )}
                      </Button>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
