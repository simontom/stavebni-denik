/**
 * Shared discriminated state returned by the project create/edit server
 * actions and consumed by the `ProjectForm` client component. Kept in a
 * directive-free module so both the server actions and the client form
 * can import it without crossing the server/client boundary at runtime.
 */
export type ProjectFormState =
  | { status: "idle" }
  | { status: "field-error"; fieldErrors: Record<string, string> }
  | { status: "site-manager-invalid" }
  | { status: "not-found" }
  | { status: "forbidden" }
  | { status: "error"; message: string };

export interface ProjectFormValues {
  name: string;
  address: string;
  cadastralArea: string;
  parcelNumbers: string;
  builder: string;
  contractor: string;
  siteManagerId: string;
  permitNumber: string;
  tdsName: string;
  bozpName: string;
  designerName: string;
  gpsLat: string;
  gpsLon: string;
  startedAt: string;
  endedAt: string;
}

export interface SiteManagerOption {
  id: string;
  displayName: string;
  nickname: string;
}

/** Blank form values used by the "new project" page. */
export const EMPTY_PROJECT_VALUES: ProjectFormValues = {
  name: "",
  address: "",
  cadastralArea: "",
  parcelNumbers: "",
  builder: "",
  contractor: "",
  siteManagerId: "",
  permitNumber: "",
  tdsName: "",
  bozpName: "",
  designerName: "",
  gpsLat: "",
  gpsLon: "",
  startedAt: "",
  endedAt: "",
};
