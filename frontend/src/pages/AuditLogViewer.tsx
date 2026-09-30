import React, { useEffect, useState } from "react";
import { api } from "../lib/api";

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

export const AuditLogViewer: React.FC = () => {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api<AuditEntry[]>("/api/audit?limit=200")
      .then((data) => setLogs(data))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Audit log se nepodařilo načíst"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Audit log</h1>
        <p className="mt-1 text-sm text-gray-500">Neměnný záznam všech změn v systému (posledních 200 událostí).</p>
      </div>

      {error && <div className="mb-4 rounded bg-red-100 p-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Čas</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Uživatel</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Akce</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Entita</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Hash</th>
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
                <td className="px-4 py-2 whitespace-nowrap text-gray-700">{new Date(log.ts).toLocaleString("cs-CZ")}</td>
                <td className="px-4 py-2 text-gray-700">{log.actorNickname ?? log.actorId ?? "systém"}</td>
                <td className="px-4 py-2 font-medium text-gray-900">{log.action}</td>
                <td className="px-4 py-2 text-gray-600">
                  {log.entityType}
                  {log.entityId ? `: ${log.entityId}` : ""}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-gray-400" title={log.rowHash}>
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
