import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { auditActionLabel, auditEntityLabel } from "../lib/auditLabels";
import { Banner, Button } from "../components/ui";
import { usePageTitle } from "../lib/pageTitle";

interface AuditEntry {
  id: number;
  ts: string;
  actorId?: string | null;
  actorNickname?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  rowHash: string;
}

interface VerifyResult {
  ok: boolean;
  totalRows: number;
  brokenAtId?: number | null;
  reason?: string | null;
  checkedAt: string;
}

export const AuditLogViewer: React.FC = () => {
  usePageTitle("Audit");
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);

  const handleVerify = async () => {
    setVerifying(true);
    try {
      setVerify(await api<VerifyResult>("/api/audit/verify"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ověření se nezdařilo");
    } finally {
      setVerifying(false);
    }
  };

  useEffect(() => {
    api<AuditEntry[]>("/api/audit?limit=200")
      .then((data) => setLogs(data))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Audit se nepodařilo načíst"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink">Audit</h1>
          <p className="mt-1 text-sm text-ink-muted">Neměnný přehled všech změn v systému (posledních 200 událostí).</p>
        </div>
        <Button variant="secondary" onClick={() => void handleVerify()} disabled={verifying}>
          {verifying ? "Ověřuji…" : "Ověřit integritu"}
        </Button>
      </div>

      {verify &&
        (verify.ok ? (
          <Banner tone="success" className="mb-4">
            Řetězec hashů je neporušený ({verify.totalRows} záznamů).
          </Banner>
        ) : (
          <Banner tone="danger" className="mb-4">
            Řetězec je porušen u záznamu #{verify.brokenAtId}: {verify.reason}
          </Banner>
        ))}

      {error && (
        <Banner tone="danger" className="mb-4">
          {error}
        </Banner>
      )}

      {/* A list of events on a phone (table-cards, index.css); the table of the desktop scrolls inside its box if it must. */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-gray-200 text-sm max-sm:table-cards">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Čas</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Uživatel</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Akce</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Objekt</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Otisk</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-3 text-gray-500">
                  Načítání…
                </td>
              </tr>
            )}
            {!loading && logs.length === 0 && !error && (
              <tr>
                <td colSpan={5} className="px-4 py-3 text-gray-500">
                  Žádné záznamy
                </td>
              </tr>
            )}
            {logs.map((log) => (
              <tr key={log.id}>
                <td className="px-4 py-2 whitespace-nowrap text-gray-700 tabular-nums">{new Date(log.ts).toLocaleString("cs-CZ")}</td>
                <td data-label="Uživatel" className="px-4 py-2 text-gray-700">
                  {log.actorNickname ?? log.actorId ?? "systém"}
                </td>
                <td data-label="Akce" className="px-4 py-2 font-medium text-gray-900">
                  {auditActionLabel(log.action)}
                  <span className="block font-mono text-xs font-normal text-ink-muted">{log.action}</span>
                </td>
                <td data-label="Objekt" className="px-4 py-2 text-gray-600">
                  {auditEntityLabel(log.entityType)}
                  {log.entityId ? <span className="block font-mono text-xs break-all text-ink-muted">{log.entityId}</span> : null}
                </td>
                <td data-label="Otisk" className="px-4 py-2 font-mono text-xs text-ink-muted" title={log.rowHash}>
                  {log.rowHash.slice(0, 12)}…
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
