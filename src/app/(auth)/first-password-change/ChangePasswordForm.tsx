"use client";

import { useActionState, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-gen";

import {
  changePasswordAction,
  type ChangePasswordState,
} from "./actions";

interface Props {
  displayName: string;
}

export function ChangePasswordForm({ displayName }: Props) {
  const [state, formAction, isPending] = useActionState<
    ChangePasswordState | undefined,
    FormData
  >(changePasswordAction, undefined);
  const [showNew, setShowNew] = useState(false);

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Změna hesla</CardTitle>
        <CardDescription>
          Vítejte, {displayName}. Před prvním použitím aplikace si prosím
          změňte heslo, které vám předal stavbyvedoucí.
        </CardDescription>
      </CardHeader>
      <form action={formAction} noValidate>
        <CardContent className="flex flex-col gap-4">
          {state?.formError && (
            <Alert variant="destructive">
              <AlertDescription>{state.formError}</AlertDescription>
            </Alert>
          )}
          {state?.policyIssues && state.policyIssues.length > 0 && (
            <Alert variant="destructive">
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {state.policyIssues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <div className="grid gap-2">
            <Label htmlFor="currentPassword">Stávající heslo</Label>
            <Input
              id="currentPassword"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              aria-invalid={!!state?.fieldErrors?.currentPassword}
            />
            {state?.fieldErrors?.currentPassword && (
              <p className="text-sm text-destructive">
                {state.fieldErrors.currentPassword}
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="newPassword">Nové heslo</Label>
            <div className="relative">
              <Input
                id="newPassword"
                name="newPassword"
                type={showNew ? "text" : "password"}
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                required
                aria-invalid={!!state?.fieldErrors?.newPassword}
                className="pr-11"
              />
              <button
                type="button"
                onClick={() => setShowNew((v) => !v)}
                aria-label={showNew ? "Skrýt heslo" : "Zobrazit heslo"}
                className="absolute inset-y-0 right-0 inline-flex w-11 items-center justify-center text-muted-foreground hover:text-foreground"
                tabIndex={-1}
              >
                {showNew ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Minimálně {MIN_PASSWORD_LENGTH} znaků, kombinace malých a
              velkých písmen, číslic a alespoň jednoho speciálního znaku.
            </p>
            {state?.fieldErrors?.newPassword && (
              <p className="text-sm text-destructive">
                {state.fieldErrors.newPassword}
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="confirmPassword">Potvrzení nového hesla</Label>
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type={showNew ? "text" : "password"}
              autoComplete="new-password"
              required
              aria-invalid={!!state?.fieldErrors?.confirmPassword}
            />
            {state?.fieldErrors?.confirmPassword && (
              <p className="text-sm text-destructive">
                {state.fieldErrors.confirmPassword}
              </p>
            )}
          </div>
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Změnit heslo
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
