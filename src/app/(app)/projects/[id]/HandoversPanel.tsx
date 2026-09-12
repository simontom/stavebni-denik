"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, FileSignature, Loader2, Plus, Trash2 } from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/dates";

import { createHandoverAction, deleteHandoverAction, signHandoverAction } from "./actions";

interface MeterState {
  name: string;
  number: string;
  value: string;
}

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

const COMMON_HANDOVER_TYPES = [
  "Předání staveniště zhotoviteli",
  "Předání staveniště zpět objednateli",
  "Dílčí předání části staveniště",
];

export function HandoversPanel({ projectId, handovers, canManage }: Props) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState(COMMON_HANDOVER_TYPES[0]);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [participants, setParticipants] = useState("");
  const [notes, setNotes] = useState("");
  const [meters, setMeters] = useState<MeterState[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [isPending, startTransition] = useTransition();

  function addMeterRow() {
    setMeters((prev) => [...prev, { name: "", number: "", value: "" }]);
  }

  function updateMeterRow(index: number, field: keyof MeterState, val: string) {
    setMeters((prev) => prev.map((m, i) => (i === index ? { ...m, [field]: val } : m)));
  }

  function removeMeterRow(index: number) {
    setMeters((prev) => prev.filter((_, i) => i !== index));
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const validMeters = meters.filter((m) => m.name.trim() && m.value.trim());

    const fd = new FormData();
    fd.append("type", type);
    fd.append("date", date);
    fd.append("participants", participants);
    fd.append("notes", notes);
    fd.append("meterStates", JSON.stringify(validMeters));

    startTransition(async () => {
      const res = await createHandoverAction(projectId, fd);
      if (res.error) {
        setError(res.error);
      } else {
        setOpen(false);
        setParticipants("");
        setNotes("");
        setMeters([]);
      }
    });
  }

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
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger
              render={
                <Button size="sm">
                  <Plus className="mr-1 size-4" aria-hidden /> Přidat předání
                </Button>
              }
            />
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
              <form onSubmit={handleCreate} className="space-y-4">
                <DialogHeader>
                  <DialogTitle>Nový zápis o předání staveniště</DialogTitle>
                  <DialogDescription>
                    Zaznamenejte předání staveniště, účastníky a počáteční stavy měřidel.
                  </DialogDescription>
                </DialogHeader>

                {error && (
                  <div className="text-destructive bg-destructive/10 rounded p-2 text-sm font-medium">
                    {error}
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="handover-type">Typ předání</Label>
                  <Input
                    id="handover-type"
                    name="type"
                    list="handover-types-list"
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    placeholder="Vyberte nebo zadejte typ předání"
                    required
                  />
                  <datalist id="handover-types-list">
                    {COMMON_HANDOVER_TYPES.map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="handover-date">Datum předání</Label>
                  <Input
                    id="handover-date"
                    type="date"
                    name="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="handover-participants">Účastníci předání</Label>
                  <Input
                    id="handover-participants"
                    name="participants"
                    placeholder="např. Ing. Jan Novák (objednatel), Petr Svoboda (zhotovitel)"
                    value={participants}
                    onChange={(e) => setParticipants(e.target.value)}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Stavy měřidel a odběrných míst</Label>
                    <Button type="button" variant="outline" size="sm" onClick={addMeterRow}>
                      <Plus className="mr-1 size-3" aria-hidden /> Přidat měřidlo
                    </Button>
                  </div>

                  {meters.length === 0 ? (
                    <p className="text-muted-foreground text-xs italic">
                      Zatím nebyla přidána žádná měřidla.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {meters.map((meter, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <Input
                            placeholder="Médium (např. Voda)"
                            value={meter.name}
                            onChange={(e) => updateMeterRow(idx, "name", e.target.value)}
                            className="flex-1"
                            required
                          />
                          <Input
                            placeholder="Výrobní číslo"
                            value={meter.number}
                            onChange={(e) => updateMeterRow(idx, "number", e.target.value)}
                            className="w-32"
                          />
                          <Input
                            placeholder="Stav (např. 150 m³)"
                            value={meter.value}
                            onChange={(e) => updateMeterRow(idx, "value", e.target.value)}
                            className="w-28"
                            required
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => removeMeterRow(idx)}
                            aria-label="Odebrat měřidlo"
                          >
                            <Trash2 className="text-destructive size-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="handover-notes">Poznámky / Podmínky předání</Label>
                  <Textarea
                    id="handover-notes"
                    name="notes"
                    placeholder="Např. napojovací body, klíče od objektu, výhrady..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </div>

                <DialogFooter className="pt-2">
                  <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                    Zrušit
                  </Button>
                  <Button type="submit" disabled={isPending}>
                    {isPending && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
                    Uložit předání
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </CardHeader>
      <CardContent>
        {handovers.length === 0 ? (
          <p className="text-muted-foreground text-sm">Žádné záznamy o předání.</p>
        ) : (
          <div className="grid gap-4">
            {handovers.map((h) => {
              const metersList: MeterState[] = Array.isArray(h.meterStates) ? h.meterStates : [];
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
                        <Trash2 className="text-destructive size-4" aria-hidden />
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
