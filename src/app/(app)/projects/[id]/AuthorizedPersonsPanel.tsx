"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/dates";

export function AuthorizedPersonsPanel({ persons }: { persons: any[] }) {
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base">Seznam pověřených osob</CardTitle>
      </CardHeader>
      <CardContent>
        {persons.length === 0 ? (
          <p className="text-sm text-muted-foreground">Žádné pověřené osoby.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {persons.map((p) => (
              <Card key={p.id} className="p-4 flex flex-col gap-2">
                <div className="flex justify-between items-start">
                  <div className="font-medium">{p.name}</div>
                  {p.revokedAt ? (
                    <Badge variant="destructive">Zrušeno</Badge>
                  ) : (
                    <Badge variant="outline">Aktivní</Badge>
                  )}
                </div>
                <div className="text-sm text-muted-foreground">{p.authorization}</div>
                {p.company && (
                  <div className="text-xs text-muted-foreground mt-2">
                    <div>{p.company}</div>
                  </div>
                )}
                <div className="text-xs text-muted-foreground mt-2 border-t pt-2">
                  Přidáno: {formatDate(p.createdAt)}
                </div>
              </Card>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
