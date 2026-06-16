import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { formatDateInput } from "@/lib/dates";
import { ForbiddenError } from "@/server/permissions";
import { requireBoss } from "@/server/rbac";
import {
  getProjectForUser,
  listSiteManagerCandidates,
} from "@/server/services/projects";

import { ProjectForm } from "../../ProjectForm";
import type { ProjectFormValues } from "../../form-types";
import { updateProjectAction } from "../actions";

export const metadata: Metadata = { title: "Úprava zakázky" };
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditProjectPage({ params }: PageProps) {
  const { id } = await params;

  let user;
  try {
    user = await requireBoss();
  } catch (err) {
    if (err instanceof ForbiddenError) redirect(`/projects/${id}`);
    throw err;
  }

  const detail = await getProjectForUser(id, user);
  if (!detail) notFound();

  const { project } = detail;
  const siteManagers = await listSiteManagerCandidates();

  const defaultValues: ProjectFormValues = {
    name: project.name,
    address: project.address,
    cadastralArea: project.cadastralArea,
    parcelNumbers: project.parcelNumbers,
    builder: project.builder,
    contractor: project.contractor,
    siteManagerId: project.siteManagerId,
    permitNumber: project.permitNumber ?? "",
    tdsName: project.tdsName ?? "",
    bozpName: project.bozpName ?? "",
    designerName: project.designerName ?? "",
    gpsLat: project.gpsLat !== null ? String(project.gpsLat) : "",
    gpsLon: project.gpsLon !== null ? String(project.gpsLon) : "",
    startedAt: project.startedAt ? formatDateInput(project.startedAt) : "",
    endedAt: project.endedAt ? formatDateInput(project.endedAt) : "",
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href={`/projects/${id}`}
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden /> Zpět na zakázku
        </Link>
        <h1 className="text-xl font-semibold">Úprava zakázky</h1>
      </div>

      <ProjectForm
        action={updateProjectAction.bind(null, id)}
        siteManagers={siteManagers}
        defaultValues={defaultValues}
        submitLabel="Uložit změny"
        cancelHref={`/projects/${id}`}
      />
    </div>
  );
}
