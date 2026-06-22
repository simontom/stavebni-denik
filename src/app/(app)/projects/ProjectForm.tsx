"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type {
  ProjectFormState,
  ProjectFormValues,
  SiteManagerOption,
} from "./form-types";

interface Props {
  action: (
    prev: ProjectFormState | undefined,
    data: FormData,
  ) => Promise<ProjectFormState | undefined>;
  siteManagers: SiteManagerOption[];
  defaultValues: ProjectFormValues;
  submitLabel: string;
  cancelHref: string;
}

interface FieldProps {
  name: keyof ProjectFormValues;
  label: string;
  defaultValue: string;
  error?: string;
  required?: boolean;
  type?: string;
  placeholder?: string;
  inputMode?: "decimal" | "text";
  hint?: string;
}

function Field({
  name,
  label,
  defaultValue,
  error,
  required,
  type = "text",
  placeholder,
  inputMode,
  hint,
}: FieldProps) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>
        {label}{" "}
        {!required && <span className="text-muted-foreground">(volitelné)</span>}
      </Label>
      <Input
        id={name}
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        inputMode={inputMode}
        aria-invalid={!!error}
      />
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export function ProjectForm({
  action,
  siteManagers,
  defaultValues,
  submitLabel,
  cancelHref,
}: Props) {
  const [state, formAction, isPending] = useActionState<
    ProjectFormState | undefined,
    FormData
  >(action, undefined);
  const [siteManagerId, setSiteManagerId] = useState(
    defaultValues.siteManagerId,
  );

  const fieldErrors =
    state?.status === "field-error" ? state.fieldErrors : undefined;

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state?.status === "site-manager-invalid" && (
        <Alert variant="destructive">
          <AlertDescription>
            Vybraný stavbyvedoucí není platný. Vyberte aktivního uživatele s
            rolí stavbyvedoucí.
          </AlertDescription>
        </Alert>
      )}
      {state?.status === "not-found" && (
        <Alert variant="destructive">
          <AlertDescription>Zakázka nebyla nalezena.</AlertDescription>
        </Alert>
      )}
      {state?.status === "forbidden" && (
        <Alert variant="destructive">
          <AlertDescription>
            Nemáte oprávnění ke správě zakázek.
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
          <CardTitle className="text-base">Identifikační údaje stavby</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field
              name="name"
              label="Název stavby"
              required
              defaultValue={defaultValues.name}
              error={fieldErrors?.name}
              placeholder="napr. Novostavba RD Hlučín"
            />
          </div>
          <Field
            name="address"
            label="Místo stavby"
            required
            defaultValue={defaultValues.address}
            error={fieldErrors?.address}
            placeholder="ulice, č.p., obec"
          />
          <Field
            name="cadastralArea"
            label="Katastrální území"
            required
            defaultValue={defaultValues.cadastralArea}
            error={fieldErrors?.cadastralArea}
            placeholder="napr. Hlučín"
          />
          <Field
            name="parcelNumbers"
            label="Parcelní čísla"
            required
            defaultValue={defaultValues.parcelNumbers}
            error={fieldErrors?.parcelNumbers}
            placeholder="napr. 123/4, 123/5"
          />
          <Field
            name="permitNumber"
            label="Č. stavebního povolení"
            defaultValue={defaultValues.permitNumber}
            error={fieldErrors?.permitNumber}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Účastníci výstavby</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            name="builder"
            label="Stavebník"
            required
            defaultValue={defaultValues.builder}
            error={fieldErrors?.builder}
          />
          <Field
            name="contractor"
            label="Zhotovitel"
            required
            defaultValue={defaultValues.contractor}
            error={fieldErrors?.contractor}
          />

          <div className="grid gap-1.5">
            <Label htmlFor="siteManagerId">Stavbyvedoucí</Label>
            <Select
              value={siteManagerId}
              onValueChange={(v) => setSiteManagerId(v as string)}
            >
              <SelectTrigger id="siteManagerId" aria-invalid={!!fieldErrors?.siteManagerId}>
                <SelectValue placeholder="Vyberte stavbyvedoucího">
                  {(value) => {
                    const found = siteManagers.find((m) => m.id === value);
                    return found
                      ? `${found.displayName} (${found.nickname})`
                      : "Vyberte stavbyvedoucího";
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {siteManagers.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.displayName} ({m.nickname})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input type="hidden" name="siteManagerId" value={siteManagerId} />
            {siteManagers.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Žádný stavbyvedoucí. Nejdřív vytvořte uživatele s rolí
                stavbyvedoucí.
              </p>
            )}
            {fieldErrors?.siteManagerId && (
              <p className="text-sm text-destructive">
                {fieldErrors.siteManagerId}
              </p>
            )}
          </div>

          <Field
            name="tdsName"
            label="Technický dozor stavebníka (TDS)"
            defaultValue={defaultValues.tdsName}
            error={fieldErrors?.tdsName}
          />
          <Field
            name="bozpName"
            label="Koordinátor BOZP"
            defaultValue={defaultValues.bozpName}
            error={fieldErrors?.bozpName}
          />
          <Field
            name="designerName"
            label="Projektant"
            defaultValue={defaultValues.designerName}
            error={fieldErrors?.designerName}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Termíny a poloha</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            name="startedAt"
            label="Zahájení stavby"
            type="date"
            defaultValue={defaultValues.startedAt}
            error={fieldErrors?.startedAt}
          />
          <Field
            name="endedAt"
            label="Dokončení stavby"
            type="date"
            defaultValue={defaultValues.endedAt}
            error={fieldErrors?.endedAt}
          />
          <Field
            name="gpsLat"
            label="GPS šířka"
            defaultValue={defaultValues.gpsLat}
            error={fieldErrors?.gpsLat}
            inputMode="decimal"
            placeholder="napr. 49.8209"
            hint="Pro automatický snapshot počasí u denních záznamů."
          />
          <Field
            name="gpsLon"
            label="GPS délka"
            defaultValue={defaultValues.gpsLon}
            error={fieldErrors?.gpsLon}
            inputMode="decimal"
            placeholder="napr. 18.1925"
          />
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="outline" render={<Link href={cancelHref} />}>
          Zrušit
        </Button>
        <Button type="submit" disabled={isPending || siteManagers.length === 0}>
          {isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
