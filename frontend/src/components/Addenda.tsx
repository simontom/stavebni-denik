import React, { useEffect, useState } from "react";
import { api, json } from "../lib/api";

interface Addendum {
  id: string;
  authorName: string;
  text: string;
  createdAt: string;
}

/** Longest text the server accepts (AddendumService.MAX_LENGTH). */
const MAX_LENGTH = 4000;

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("cs-CZ", { timeZone: "Europe/Prague" });
}

/**
 * The addenda of a signed daily entry: corrections and additions that stand next to it, each with its author and time.
 * They can only be added, never changed or removed, so the form has no edit or delete.
 */
export function Addenda({ entryId, canWrite }: { entryId: string; canWrite: boolean }) {
  const [addenda, setAddenda] = useState<Addendum[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ignore = false;
    api<Addendum[]>(`/api/reports/${entryId}/addenda`)
      .then((list) => {
        if (!ignore) setAddenda(list);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : "Dodatky se nepodařilo načíst");
      });
    return () => {
      ignore = true;
    };
  }, [entryId]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || text.trim() === "") return;
    setBusy(true);
    setError("");
    try {
      const created = await api<Addendum>(`/api/reports/${entryId}/addenda`, { method: "POST", body: json({ text }) });
      setAddenda((current) => [...current, created]);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dodatek se nepodařilo uložit");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="addenda-title" className="mt-6 space-y-3 border-t border-gray-200 pt-4">
      <h3 id="addenda-title" className="font-semibold text-gray-900">
        Dodatky
      </h3>
      {addenda.length === 0 ? (
        <p className="text-sm text-gray-500">K tomuto záznamu zatím není žádný dodatek.</p>
      ) : (
        <ul className="space-y-3">
          {addenda.map((a) => (
            <li key={a.id} className="rounded border border-gray-200 bg-gray-50 p-3 text-sm">
              <div className="text-xs text-gray-500">
                {a.authorName}, {formatTime(a.createdAt)}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-gray-800">{a.text}</p>
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form onSubmit={(e) => void add(e)} className="space-y-2">
          <label htmlFor="addendum-text" className="block text-xs font-medium text-gray-700">
            Nový dodatek (oprava nebo doplnění; po uložení ho nelze změnit ani smazat)
          </label>
          <textarea
            id="addendum-text"
            name="addendumText"
            rows={3}
            maxLength={MAX_LENGTH}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy || text.trim() === ""}
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Přidat dodatek
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
