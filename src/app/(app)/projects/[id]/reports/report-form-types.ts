/**
 * Shared discriminated state returned by the daily-report create/edit
 * server actions and consumed by the `ReportForm` client component. Kept
 * directive-free so both sides import it without crossing the
 * server/client boundary at runtime.
 */
export type ReportFormState =
  | { status: "idle" }
  | { status: "field-error"; fieldErrors: Record<string, string> }
  | { status: "exists" }
  | { status: "not-found" }
  | { status: "forbidden" }
  | { status: "locked" }
  | { status: "error"; message: string };

export interface WorkerLineValue {
  trade: string;
  count: string;
}

export interface ReportFormValues {
  workersByTrade: WorkerLineValue[];
  workDescription: string;
  materialsIn: string;
  machinery: string;
  testsAndChecks: string;
  safetyNotes: string;
  defects: string;
  otherNotes: string;
}

/** Blank values used when creating a new daily report. */
export const EMPTY_REPORT_VALUES: ReportFormValues = {
  workersByTrade: [],
  workDescription: "",
  materialsIn: "",
  machinery: "",
  testsAndChecks: "",
  safetyNotes: "",
  defects: "",
  otherNotes: "",
};
