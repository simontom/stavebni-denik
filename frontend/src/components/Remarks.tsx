import React, { useEffect, useState } from "react";
import { api, json } from "../lib/api";

interface Remark {
  id: string;
  authorName: string;
  type: string;
  text: string;
  externalAuthor?: string | null;
  createdAt: string;
}

/** Longest text the server accepts (RemarkService.MAX_LENGTH). */
const MAX_LENGTH = 4000;

const TYPE_LABELS: Record<string, string> = {
  INSPECTOR_REMARK: "technický dozor / dozor",
  INVESTOR_NOTE: "stavebník",
  EXTERNAL_ENTRY: "orgán nebo osoba bez účtu",
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("cs-CZ", { timeZone: "Europe/Prague" });
}

/**
 * Entries of other parties in the diary (technical supervision, the client, authorities): made also after the day's
 * entry was signed, never changed or removed. An inspector or the client writes in their own name; the project's manager
 * records an entry for an outside party and has to name it.
 */
export function Remarks({ entryId, role }: { entryId: string; role: string | null }) {
  const [remarks, setRemarks] = useState<Remark[]>([]);
  const [text, setText] = useState("");
  const [externalAuthor, setExternalAuthor] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const isManager = role === "BOSS";
  const canWrite = isManager || role === "INSPECTOR" || role === "INVESTOR";

  useEffect(() => {
    let ignore = false;
    api<Remark[]>(`/api/reports/${entryId}/remarks`)
      .then((list) => {
        if (!ignore) setRemarks(list);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : "Zápisy se nepodařilo načíst");
      });
    return () => {
      ignore = true;
    };
  }, [entryId]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || text.trim() === "" || (isManager && externalAuthor.trim() === "")) return;
    setBusy(true);
    setError("");
    try {
      const created = await api<Remark>(`/api/reports/${entryId}/remarks`, {
        method: "POST",
        body: json({ text, externalAuthor: isManager ? externalAuthor : undefined }),
      });
      setRemarks((current) => [...current, created]);
      setText("");
      setExternalAuthor("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Zápis se nepodařilo uložit");
    } finally {
      setBusy(false);
    }
  };

  // Nothing to show and nobody who could write: no empty box.
  if (remarks.length === 0 && !canWrite && !error) return null;

  return (
    <section aria-labelledby="remarks-title" className="space-y-3">
      <h3 id="remarks-title" className="font-semibold text-gray-900">
        Zápisy dalších osob
      </h3>
      {remarks.length === 0 ? (
        <p className="text-sm text-gray-500">K tomuto záznamu zatím nikdo další nezapsal.</p>
      ) : (
        <ul className="space-y-3">
          {remarks.map((r) => (
            <li key={r.id} className="rounded border border-gray-200 bg-gray-50 p-3 text-sm">
              <div className="text-xs text-gray-500">
                {r.externalAuthor ? `${r.externalAuthor} (zapsal ${r.authorName})` : r.authorName}
                {" · "}
                {TYPE_LABELS[r.type] ?? r.type}
                {", "}
                {formatTime(r.createdAt)}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-gray-800">{r.text}</p>
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form onSubmit={(e) => void add(e)} className="space-y-2">
          {isManager && (
            <div>
              <label htmlFor="remark-author" className="block text-xs font-medium text-gray-700">
                Za koho zápis pořizujete (orgán nebo osoba bez účtu)
              </label>
              <input
                id="remark-author"
                name="remarkAuthor"
                type="text"
                maxLength={200}
                value={externalAuthor}
                onChange={(e) => setExternalAuthor(e.target.value)}
                className="w-full rounded-md border border-gray-300 p-2 text-sm"
              />
            </div>
          )}
          <label htmlFor="remark-text" className="block text-xs font-medium text-gray-700">
            Nový zápis (po uložení ho nelze změnit ani smazat)
          </label>
          <textarea
            id="remark-text"
            name="remarkText"
            rows={3}
            maxLength={MAX_LENGTH}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy || text.trim() === "" || (isManager && externalAuthor.trim() === "")}
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Přidat zápis
          </button>
        </form>
      )}
      {error && (
        <div role="alert" className="text-sm text-red-600">
          {error}
        </div>
      )}
    </section>
  );
}
