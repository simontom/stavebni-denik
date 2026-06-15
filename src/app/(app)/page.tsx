import Link from "next/link";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/rbac";

export const dynamic = "force-dynamic";

/**
 * Authenticated landing / dashboard. The real "today on the building site"
 * dashboard comes in Stage 4 — for now it serves as a navigation hub.
 */
export default async function DashboardPage() {
  const user = await requireUser();
  const isBoss = user.role === "BOSS";

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Vítejte, {user.displayName}</h1>
        <p className="text-muted-foreground">
          Elektronický stavební deník dle § 157 stavebního zákona.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        <Link href="/projects" className="group">
          <Card className="h-full transition-colors group-hover:border-primary">
            <CardHeader>
              <CardTitle>Zakázky</CardTitle>
              <CardDescription>
                Přehled staveb, k nimž máte přístup, a denní záznamy.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Otevřít →
            </CardContent>
          </Card>
        </Link>

        {isBoss && (
          <>
            <Link href="/admin/users" className="group">
              <Card className="h-full transition-colors group-hover:border-primary">
                <CardHeader>
                  <CardTitle>Uživatelé</CardTitle>
                  <CardDescription>
                    Přidat pracovníka / dozor, vygenerovat heslo, deaktivovat účet.
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  Otevřít →
                </CardContent>
              </Card>
            </Link>

            <Link href="/admin/audit" className="group">
              <Card className="h-full transition-colors group-hover:border-primary">
                <CardHeader>
                  <CardTitle>Audit log</CardTitle>
                  <CardDescription>
                    Záznamy všech změn a ověření integrity řetězu.
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  Otevřít →
                </CardContent>
              </Card>
            </Link>
          </>
        )}
      </section>
    </div>
  );
}
