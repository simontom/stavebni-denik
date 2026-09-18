"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";

import { createHandoverAction } from "./actions";

export interface MeterState {
  name: string;
  number: string;
  value: string;
}

const COMMON_HANDOVER_TYPES = [
  "Předání staveniště zhotoviteli",
  "Předání staveniště zpět objednateli",
  "Dílčí předání části staveniště",
];

interface CreateHandoverDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateHandoverDialog({ projectId, open, onOpenChange }: CreateHandoverDialogProps) {
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

  function resetForm() {
    setType(COMMON_HANDOVER_TYPES[0]);
    setDate(new Date().toISOString().slice(0, 10));
    setParticipants("");
    setNotes("");
    setMeters([]);
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

    const validMeters = meters.filter((m) => m.name.trim() && m.value.trim());

    startTransition(async () => {
      const res = await createHandoverAction({
        projectId,
        type,
        date: new Date(date),
        participants,
        notes: notes || undefined,
        meterStates: validMeters,
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
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
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
  );
}
