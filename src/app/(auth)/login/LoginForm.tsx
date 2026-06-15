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

import { loginAction, type LoginState } from "./actions";

const LOGIN_ERROR_MESSAGES: Record<NonNullable<LoginState["error"]>, string> = {
  InvalidCredentials: "Neplatné přihlašovací jméno nebo heslo.",
  AccountDisabled: "Účet je deaktivován. Kontaktujte stavbyvedoucího.",
  RateLimited: "Příliš mnoho neúspěšných pokusů. Zkuste to znovu za 15 minut.",
  Unknown: "Při přihlášení došlo k neznámé chybě. Zkuste to prosím znovu.",
};

interface Props {
  callbackUrl?: string;
}

export function LoginForm({ callbackUrl }: Props) {
  const [state, formAction, isPending] = useActionState<
    LoginState | undefined,
    FormData
  >(loginAction, undefined);
  const [showPassword, setShowPassword] = useState(false);

  const errorMessage = state?.error ? LOGIN_ERROR_MESSAGES[state.error] : null;

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Přihlášení</CardTitle>
        <CardDescription>
          Použijte přihlašovací jméno a heslo, které jste obdrželi od
          stavbyvedoucího.
        </CardDescription>
      </CardHeader>
      <form action={formAction} noValidate>
        <CardContent className="flex flex-col gap-4">
          {errorMessage && (
            <Alert variant="destructive" aria-live="polite">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}

          <div className="grid gap-2">
            <Label htmlFor="nickname">Přihlašovací jméno</Label>
            <Input
              id="nickname"
              name="nickname"
              type="text"
              autoComplete="username"
              required
              autoFocus
              maxLength={64}
              spellCheck={false}
              autoCapitalize="off"
              inputMode="text"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="password">Heslo</Label>
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                maxLength={256}
                className="pr-11"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Skrýt heslo" : "Zobrazit heslo"}
                className="absolute inset-y-0 right-0 inline-flex w-11 items-center justify-center text-muted-foreground hover:text-foreground"
                tabIndex={-1}
              >
                {showPassword ? (
                  <EyeOff className="size-4" aria-hidden />
                ) : (
                  <Eye className="size-4" aria-hidden />
                )}
              </button>
            </div>
          </div>

          {callbackUrl && (
            <input type="hidden" name="callbackUrl" value={callbackUrl} />
          )}
        </CardContent>
        <CardFooter className="mt-2">
          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Přihlásit se
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
