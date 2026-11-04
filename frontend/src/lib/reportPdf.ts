import { apiFetch } from "./api";

/**
 * Downloads the PDF of one entry (`GET /api/reports/{id}/pdf`) and hands it to the browser as `stavebni-denik-<day>.pdf`. The project
 * page (a PDF for every entry of the list) and the entry page (the bar of actions) both use it. A refusal comes back as an `Error`
 * with the server's own explanation ("Export do PDF není na serveru dostupný"), or a Czech sentence when it said nothing.
 */
export async function downloadReportPdf(entry: { id: string; date: string }): Promise<void> {
  const res = await apiFetch(`/api/reports/${entry.id}/pdf`);
  if (!res.ok) {
    let message = "Chyba při stahování PDF";
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      // the body was not JSON
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `stavebni-denik-${entry.date}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
