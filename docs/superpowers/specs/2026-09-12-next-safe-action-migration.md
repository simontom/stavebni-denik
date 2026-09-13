# Přechod na `next-safe-action` pro Server Actions

Tento dokument definuje novou architekturu Server Actions a sjednocený způsob zpracování chyb a oprávnění s pomocí knihovny `next-safe-action`.

## Současný stav

Nyní se Server Actions píší jako čisté asynchronní funkce přijímající `FormData`. Role (RBAC) se kontroluje manuálním voláním `requireUser`, `requireBoss` atd. Audit log kontext se načítá manuálním voláním `getAuditContext`. Ošetření chyb a validací vstupu znamená vracet struktury jako `{ status: 'field-error', fieldErrors: ... }` nebo `{ status: 'error', message: '...' }` na základě manuální konfigurace `zod` parse.

Tento přístup:

- vyžaduje opakující se kód (`try/catch`, manuální Zod validace, RBAC kontroly).
- postrádá typovou bezpečnost návratových hodnot při chybě.
- nutí klientské komponenty udržovat si vlastní stavy a řešit `useTransition` / `startTransition`.

## Nová architektura

Zavedeme `next-safe-action` (v8) a vytvoříme globální infrastrukturu předkonfigurovaných klientů, tzv. **Granulární klienti pro každou roli**.

1. **`actionClient`**: bázový klient pro veřejné či obecné akce, který zachytává neošetřené chyby (přes `handleServerError`).
2. **`authActionClient`**: middleware, který přes `requireUser()` ověří autentizaci a přes `getAuditContext()` získá kontext volání. Vloží do vlastnosti `ctx` v akci objekty `user` a `auditContext`.
3. **`adminActionClient`**: rozšíření, které místo obyčejného uživatele vyžaduje administrátora (přes `requireAdmin()`).
4. **`bossActionClient`**: rozšíření, které vyžaduje stavbyvedoucího (`requireBoss()`).

### Deklarace akcí

Akce budou nyní definovány pomocí těchto klientů. Přijímaná data budou typována pomocí Zod schémat:

```typescript
const toggleActiveSchema = z.object({
  userId: z.string(),
  isActive: z.boolean(),
});

export const setUserActiveAction = adminActionClient
  .schema(toggleActiveSchema)
  .action(async ({ parsedInput, ctx }) => {
    // V ctx máme jistotu, že ctx.user je admin, a ctx.auditContext je připraven.
    await someDbCall(parsedInput.userId, parsedInput.isActive, ctx.auditContext);
    return { ok: true };
  });
```

### Klientské volání (React)

Klientské komponenty využijí hook `useAction` z balíčku `next-safe-action/hooks`. Tím se zbavíme `useTransition` boilerplate a navážeme chybové stavy:

```typescript
const { execute, isExecuting, result } = useAction(setUserActiveAction, {
  onSuccess: ({ data }) => toast.success("Hotovo"),
  onError: ({ error }) => {
    if (error.serverError) toast.error(error.serverError);
  },
});

// V onClick:
execute({ userId, isActive });
```

U formulářových akcí se data přetransformují buď na objekt (plain object předaný do `execute`), anebo se využije nativní napojení. V tomto pilotním návrhu navrhujeme extrahovat data z formuláře na objekt (např. pomocí Zod schema) a použít ho v `execute()`.

## Strategie migrace (Pilotní fáze)

1. **Jádro (Infrastructure)**
   - Instalace knihovny `next-safe-action`.
   - Vytvoření `/src/server/safe-action.ts` s definicemi klientů.
   - Definice globální obsluhy chyb `handleServerError`, mapující systémové chyby na srozumitelné zprávy.
2. **Modul: Admin Users**
   - V souboru `src/app/(app)/admin/users/actions.ts` přepisujeme akce:
     - `setUserActiveAction`
     - `resetPasswordAction`
     - `createUserAction`
     - `editUserAction`
     - `deleteUserAction`
   - V souvisejících klientských komponentách nahrazujeme dosavadní asynchronní volání hookem `useAction`.
3. **Validace**
   - Spustit všechny existující TDD integrační testy pro `admin/users`. Očekáváme zelený průchod. Testy, které původně posílaly `FormData`, se upraví tak, aby posílaly přímo Zod parametry (pokud nezvolíme použití `zfd`). Pro pilot použijeme standardní objekty přes Zod.

## Mimo rámec pilotu

Zbývající moduly a úpravy E2E testů budou realizovány v navazujících iteracích, jakmile zvalidujeme funkčnost na modulu `Admin Users`.
