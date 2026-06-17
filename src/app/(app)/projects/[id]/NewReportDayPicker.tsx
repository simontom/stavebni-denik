"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  projectId: string;
  /** Today's date pre-filled in YYYY-MM-DD (Prague), so the SSR markup is stable. */
  todayDateStr: string;
}

/**
 * Date picker that navigates to `/projects/{id}/reports/{date}`.
 * Defaults to today's Prague-calendar day; lets the user pick any past
 * day for back-filling. The target page renders the create form when no
 * report exists for that day yet.
 */
export function NewReportDayPicker({ projectId, todayDateStr }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(todayDateStr);
  const [pending, startTransition] = useTransition();

  function open(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    startTransition(() => {
      router.push(`/projects/${projectId}/reports/${date}`);
    });
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="new-report-date">Datum záznamu</Label>
          <Input
            id="new-report-date"
            type="date"
            value={value}
            max={todayDateStr}
            onChange={(e) => setValue(e.target.value)}
            className="sm:w-44"
          />
        </div>
        <Button
          type="button"
          disabled={pending || value.length === 0}
          onClick={() => open(value)}
        >
          Otevřít den
        </Button>
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={() => open(todayDateStr)}
      >
        Nový pro dnešek
      </Button>
    </div>
  );
}
