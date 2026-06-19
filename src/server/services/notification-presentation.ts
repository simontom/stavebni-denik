import "server-only";

import type { NotificationView } from "@/server/services/notifications";

/**
 * Map a notification kind + payload to user-facing copy.
 *
 * Kept on the server side so the client bundle stays small and the
 * Czech wording lives next to its data shape. New kinds add a case
 * here; the bell + the /notifications page both read these strings.
 */

export interface NotificationPresentation {
  title: string;
  body: string;
}

export function presentNotification(
  n: NotificationView,
): NotificationPresentation {
  switch (n.kind) {
    case "audit.chain_broken": {
      const payload = n.payload as { rowId?: string | number } | null;
      const rowSuffix =
        payload && payload.rowId !== undefined
          ? ` (řádek #${payload.rowId})`
          : "";
      return {
        title: "Audit log narušen",
        body: `Hash chain auditu selhal při ověření${rowSuffix}. Zkontrolujte log a vyšetřete příčinu.`,
      };
    }
    case "report.signed": {
      const payload =
        (n.payload as {
          projectName?: string;
          date?: string;
          signerName?: string;
        } | null) ?? null;
      const project = payload?.projectName ?? "zakázka";
      const date = payload?.date ? `, ${payload.date}` : "";
      const signer = payload?.signerName ? ` — ${payload.signerName}` : "";
      return {
        title: "Záznam podepsán",
        body: `${project}${date}${signer}.`,
      };
    }
    default:
      return { title: n.kind, body: "" };
  }
}
