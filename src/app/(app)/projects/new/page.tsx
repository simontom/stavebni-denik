import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { ForbiddenError } from "@/server/permissions";
import { requireBoss } from "@/server/rbac";
import { listSiteManagerCandidates } from "@/server/services/projects";

import { ProjectForm } from "../ProjectForm";
import { EMPTY_PROJECT_VALUES } from "../form-types";
import { createProjectAction } from "./actions";

export const metadata: Metadata = { title: "Nová zakázka" };
export const dynamic = "force-dynamic";

export default async function NewProjectPage() {
  try {
    await requireBoss();
  } catch (err) {
    if (err instanceof ForbiddenError) redirect("/projects");
    throw err;
  }

  const siteManagers = await listSiteManagerCandidates();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href="/projects"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden /> Zpět na zakázky
        </Link>
        <div>
          <h1 className="text-xl font-semibold">Nová zakázka</h1>
          <p className="text-sm text-muted-foreground">
            Vyplňte identifikační údaje stavby. Doplňující údaje a členy týmu
            lze upravit kdykoli později.
          </p>
        </div>
      </div>

      <ProjectForm
        action={createProjectAction}
        siteManagers={siteManagers}
        defaultValues={EMPTY_PROJECT_VALUES}
        submitLabel="Založit zakázku"
        cancelHref="/projects"
      />
    </div>
  );
}
