// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_EXPIRED_EVENT } from "./api";
import { downloadReportPdf } from "./reportPdf";

const response = (status: number, body: BodyInit | null, type = "application/json") => new Response(body, { status, headers: { "Content-Type": type } });

let clicked: { href: string; download: string }[];
const originalFetch = globalThis.fetch;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  clicked = [];
  URL.createObjectURL = vi.fn(() => "blob:pdf-1");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, download: this.download });
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  vi.restoreAllMocks();
});

describe("downloadReportPdf", () => {
  it("asks for the PDF of the entry by its id and hands the file to the browser under a name that has the day in it", async () => {
    const fetchMock = vi.fn(async () => response(200, "%PDF-1.7", "application/pdf"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await downloadReportPdf({ id: "11111111-2222-3333-4444-555555555555", date: "2026-10-01" });
    expect(fetchMock).toHaveBeenCalledWith("/api/reports/11111111-2222-3333-4444-555555555555/pdf", {});
    expect(clicked).toEqual([{ href: "blob:pdf-1", download: "stavebni-denik-2026-10-01.pdf" }]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:pdf-1");
    expect(document.querySelector("a[download]"), "the temporary link is taken away again").toBeNull();
  });

  it("says what the server said when it refuses (typst is not there, too many exports)", async () => {
    globalThis.fetch = vi.fn(async () => response(503, JSON.stringify({ error: "Export do PDF není na serveru dostupný" }))) as unknown as typeof fetch;
    await expect(downloadReportPdf({ id: "x", date: "2026-10-01" })).rejects.toThrow("Export do PDF není na serveru dostupný");
    expect(clicked).toEqual([]);
  });

  it("has words of its own for an answer that says nothing", async () => {
    globalThis.fetch = vi.fn(async () => response(500, "oops", "text/plain")) as unknown as typeof fetch;
    await expect(downloadReportPdf({ id: "x", date: "2026-10-01" })).rejects.toThrow("Chyba při stahování PDF");
  });

  it("raises the sign-in event when the session is over, like every call of the application", async () => {
    globalThis.fetch = vi.fn(async () => response(401, "{}")) as unknown as typeof fetch;
    const events: string[] = [];
    const listener = (e: Event) => events.push((e as CustomEvent<{ method: string }>).detail.method);
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);
    try {
      await expect(downloadReportPdf({ id: "x", date: "2026-10-01" })).rejects.toThrow(/Přihlášení vypršelo/);
      expect(events).toEqual(["GET"]);
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
    }
  });
});
