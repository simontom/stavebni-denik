import Link from "next/link";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  projectId: string;
}

/**
 * Date-range PDF export form. The browser submits a plain GET to
 * `/api/projects/[id]/pdf?from=&to=` and the route's
 * `Content-Disposition: attachment` header triggers the download —
 * no client JS needed.
 *
 * Both dates are optional: blank `from`/`to` means "since the start"
 * / "until today" respectively.
 */
export function PdfExportForm({ projectId }: Props) {
  return (
    <form
      action={`/api/projects/${projectId}/pdf`}
      method="GET"
      className="grid gap-3 sm:grid-cols-[auto_auto_1fr] sm:items-end"
    >
      <div className="grid gap-1.5">
        <Label htmlFor="pdf-from">Od</Label>
        <Input id="pdf-from" name="from" type="date" className="sm:w-40" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pdf-to">Do</Label>
        <Input id="pdf-to" name="to" type="date" className="sm:w-40" />
      </div>
      <div className="flex flex-wrap items-end justify-end gap-2">
        <Button type="submit">
          <Download className="size-4" aria-hidden /> Stáhnout PDF
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          render={
            <Link
              href={`/print/project/${projectId}`}
              target="_blank"
              rel="noreferrer"
            />
          }
        >
          Náhled k tisku
        </Button>
      </div>
      <p className="text-xs text-muted-foreground sm:col-span-3">
        Patička každé strany obsahuje krátký otisk posledního řádku auditního
        logu — výstup je tak dohledatelný v hash-řetězci a doložitelný oproti
        manipulaci.
      </p>
    </form>
  );
}
