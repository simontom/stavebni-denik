import { FileSpreadsheet } from "lucide-react";

import { Button } from "@/components/ui/button";

interface Props {
  projectId: string;
}

/**
 * CSV export panel — 3 download buttons (reports, materials, visits).
 *
 * Browser submits a plain GET to `/api/projects/[id]/export.csv?type=...`
 * and the route's `Content-Disposition: attachment` header triggers
 * the download.
 *
 * Output is UTF-8 with BOM (Excel-friendly). Optional `from`/`to` query
 * params for date filtering are NOT exposed in UI yet — first iteration
 * exports the full project.
 */
export function CsvExportButtons({ projectId }: Props) {
  const base = `/api/projects/${projectId}/export.csv`;
  // <Button render={<a/>}> = @base-ui pattern (žádný asChild — Radix-only).
  // Direct <a> click triggers Content-Disposition download.
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          render={<a href={`${base}?type=reports`} download />}
        >
          <FileSpreadsheet className="size-4" aria-hidden /> Záznamy (CSV)
        </Button>
        <Button
          variant="outline"
          size="sm"
          render={<a href={`${base}?type=materials`} download />}
        >
          <FileSpreadsheet className="size-4" aria-hidden /> Materiál (CSV)
        </Button>
        <Button
          variant="outline"
          size="sm"
          render={<a href={`${base}?type=visits`} download />}
        >
          <FileSpreadsheet className="size-4" aria-hidden /> Návštěvy (CSV)
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        UTF-8 s BOM (Excel / Google Sheets bez šifrovaných znaků).
      </p>
    </div>
  );
}
