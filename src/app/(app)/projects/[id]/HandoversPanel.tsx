"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/dates";

export function HandoversPanel({ handovers }: { handovers: any[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Záznamy o předání staveniště</CardTitle>
      </CardHeader>
      <CardContent>
        {handovers.length === 0 ? (
          <p className="text-sm text-muted-foreground">Žádné záznamy o předání.</p>
        ) : (
          <div className="grid gap-4">
            {handovers.map((h) => (
              <Card key={h.id} className="p-4 flex flex-col gap-2">
                <div className="flex justify-between items-start">
                  <div className="font-medium">{h.type}</div>
                  <div className="text-sm text-muted-foreground">{formatDate(h.date)}</div>
                </div>
                {h.notes && <div className="text-sm mt-2">{h.notes}</div>}
              </Card>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
