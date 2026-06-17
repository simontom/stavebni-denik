"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import type {
  ReportFormState,
  ReportFormValues,
  WorkerLineValue,
} from "./report-form-types";

interface Props {
  action: (
    prev: ReportFormState | undefined,
    data: FormData,
  ) => Promise<ReportFormState | undefined>;
  defaultValues: ReportFormValues;
  submitLabel: string;
  cancelHref: string;
}

interface AreaFieldProps {
  name: keyof Omit<ReportFormValues, "workersByTrade">;
  label: string;
  defaultValue: string;
  error?: string;
  required?: boolean;
  placeholder?: string;
  rows?: number;
}

function AreaField({
  name,
  label,
  defaultValue,
  error,
  required,
  placeholder,
  rows = 3,
}: AreaFieldProps) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>
        {label}{" "}
        {!required && (
          <span className="text-muted-foreground">(volitelné)</span>
        )}
      </Label>
      <Textarea
        id={name}
        name={name}
        rows={rows}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-invalid={!!error}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export function ReportForm({
  action,
  defaultValues,
  submitLabel,
  cancelHref,
}: Props) {
  const [state, formAction, isPending] = useActionState<
    ReportFormState | undefined,
    FormData
  >(action, undefined);

  const [workers, setWorkers] = useState<WorkerLineValue[]>(
    defaultValues.workersByTrade.length > 0
      ? defaultValues.workersByTrade
      : [{ trade: "", count: "" }],
  );

  const fieldErrors =
    state?.status === "field-error" ? state.fieldErrors : undefined;

  function updateWorker(index: number, patch: Partial<WorkerLineValue>) {
    setWorkers((prev) =>
      prev.map((w, i) => (i === index ? { ...w, ...patch } : w)),
    );
  }

  function addWorker() {
    setWorkers((prev) => [...prev, { trade: "", count: "" }]);
  }

  function removeWorker(index: number) {
    setWorkers((prev) =>
      prev.length <= 1 ? prev : prev.filter((_, i) => i !== index),
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state?.status === "exists" && (
        <Alert variant="destructive">
          <AlertDescription>
            Pro tento den už denní záznam existuje.
          </AlertDescription>
        </Alert>
      )}
      {state?.status === "not-found" && (
        <Alert variant="destructive">
          <AlertDescription>Denní záznam nebyl nalezen.</AlertDescription>
        </Alert>
      )}
      {state?.status === "forbidden" && (
        <Alert variant="destructive">
          <AlertDescription>
            Nemáte oprávnění tento záznam vytvořit nebo upravit.
          </AlertDescription>
        </Alert>
      )}
      {state?.status === "locked" && (
        <Alert variant="destructive">
          <AlertDescription>
            Záznam je po podpisu uzamčen; změny lze provést jen dodatkem.
          </AlertDescription>
        </Alert>
      )}
      {state?.status === "error" && (
        <Alert variant="destructive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pracovníci na stavbě</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {workers.map((w, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="grid flex-1 gap-1.5">
                {i === 0 && <Label>Profese</Label>}
                <Input
                  name="workerTrade"
                  value={w.trade}
                  onChange={(e) => updateWorker(i, { trade: e.target.value })}
                  placeholder="napr. zedník"
                />
              </div>
              <div className="grid w-24 gap-1.5">
                {i === 0 && <Label>Počet</Label>}
                <Input
                  name="workerCount"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={w.count}
                  onChange={(e) => updateWorker(i, { count: e.target.value })}
                  placeholder="0"
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeWorker(i)}
                disabled={workers.length <= 1}
                aria-label="Odebrat řádek"
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addWorker}
            >
              <Plus className="size-4" aria-hidden /> Přidat profesi
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Průběh prací</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <AreaField
            name="workDescription"
            label="Popis provedených prací"
            required
            rows={5}
            defaultValue={defaultValues.workDescription}
            error={fieldErrors?.workDescription}
            placeholder="Co se na stavbě dnes dělalo…"
          />
          <AreaField
            name="materialsIn"
            label="Dodávky materiálu"
            defaultValue={defaultValues.materialsIn}
            error={fieldErrors?.materialsIn}
          />
          <AreaField
            name="machinery"
            label="Nasazená mechanizace"
            defaultValue={defaultValues.machinery}
            error={fieldErrors?.machinery}
          />
          <AreaField
            name="testsAndChecks"
            label="Zkoušky a měření"
            defaultValue={defaultValues.testsAndChecks}
            error={fieldErrors?.testsAndChecks}
          />
          <AreaField
            name="safetyNotes"
            label="BOZP"
            defaultValue={defaultValues.safetyNotes}
            error={fieldErrors?.safetyNotes}
          />
          <AreaField
            name="defects"
            label="Závady a nedodělky"
            defaultValue={defaultValues.defects}
            error={fieldErrors?.defects}
          />
          <AreaField
            name="otherNotes"
            label="Ostatní"
            defaultValue={defaultValues.otherNotes}
            error={fieldErrors?.otherNotes}
          />
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="outline" render={<Link href={cancelHref} />}>
          Zrušit
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
