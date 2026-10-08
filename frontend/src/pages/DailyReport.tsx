import React, { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { currentUser } from "../lib/api";

interface PhotoItem {
  id: string;
  url: string;
  name: string;
}

/** The message the server sent for a failed request ({ "error": "..." }), or a fallback. */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === "string") return body.error;
  } catch {
    // the body was not JSON
  }
  return fallback;
}

export const DailyReport: React.FC = () => {
  const { projectId, reportId } = useParams<{ projectId: string; reportId: string }>();

  // User role: investors and inspectors acknowledge, builders write and sign.
  const me = currentUser();
  const isInvestor = me?.role === "INVESTOR" || me?.role === "INSPECTOR";
  const [error, setError] = useState("");

  // Report state
  // A new entry starts empty: invented defaults would end up in a legal record if nobody noticed them.
  const [workDescription, setWorkDescription] = useState<string>("");
  const [workerTrade, setWorkerTrade] = useState<string>("");
  const [workerCount, setWorkerCount] = useState<string>("");
  // Saving is only possible once it is known whether the day already has an entry: an unloaded form
  // must never be saved over an entry that exists.
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [isControlDay, setIsControlDay] = useState<boolean>(false);
  const [constructionObj, setConstructionObj] = useState<string>("");
  const [isSigned, setIsSigned] = useState<boolean>(false);
  const [isAcknowledged, setIsAcknowledged] = useState<boolean>(false);

  // Photos
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  useEffect(() => {
    let ignore = false;
    if (projectId && reportId) {
      fetch(`/api/projects/${projectId}/reports/${reportId}`)
        .then((res) => {
          if (res.ok) return res.json();
          if (res.status === 404) return null; // no entry for this day yet: an empty form is right
          throw new Error(`Záznam se nepodařilo načíst (${res.status})`);
        })
        .then((data) => {
          if (ignore) return;
          setLoadState("ready");
          if (!data) return;
          if (data.workDescription) setWorkDescription(data.workDescription);
          if (data.isControlDay !== undefined) setIsControlDay(Boolean(data.isControlDay));
          if (data.constructionObj) setConstructionObj(data.constructionObj);
          if (data.isSigned !== undefined) setIsSigned(Boolean(data.isSigned || data.isLocked));
          if (data.isAcknowledged !== undefined) setIsAcknowledged(Boolean(data.isAcknowledged));
          if (data.workersByTrade) {
            try {
              const trades = typeof data.workersByTrade === "string" ? JSON.parse(data.workersByTrade) : data.workersByTrade;
              if (Array.isArray(trades) && trades.length > 0) {
                if (trades[0].trade) setWorkerTrade(trades[0].trade);
                if (trades[0].count) setWorkerCount(String(trades[0].count));
              }
            } catch {
              // ignore
            }
          }
          if (Array.isArray(data.photos) && data.photos.length > 0) {
            setPhotos(
              data.photos.map((p: { id: string }, index: number) => ({
                id: p.id,
                url: `/api/photos/${p.id}`,
                name: `Fotka ${index + 1}`,
              })),
            );
          }
        })
        .catch((err: unknown) => {
          if (ignore) return;
          setLoadState("failed");
          setError(err instanceof Error ? err.message : "Záznam se nepodařilo načíst");
        });
    }
    return () => {
      ignore = true;
    };
  }, [projectId, reportId]);

  const handleCreateReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loadState !== "ready") return;

    try {
      const res = await fetch(`/api/projects/${projectId}/reports/${reportId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: reportId,
          workDescription,
          workerTrade,
          workerCount,
          isControlDay,
          constructionObj,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data) {
          if (data.isControlDay !== undefined) setIsControlDay(Boolean(data.isControlDay));
          if (data.constructionObj) setConstructionObj(data.constructionObj);
          if (data.isSigned !== undefined) setIsSigned(Boolean(data.isSigned || data.isLocked));
        }
        setError("");
      } else {
        const body = await res.json().catch(() => null);
        setError(body?.error || "Záznam se nepodařilo uložit");
      }
    } catch (err) {
      console.error("Failed to create report:", err);
      setError("Záznam se nepodařilo uložit");
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
    }
  };

  const handleUploadPhoto = async () => {
    if (!selectedFile) return;

    try {
      const formData = new FormData();
      formData.append("photo", selectedFile);
      if (reportId) formData.append("reportId", reportId);
      if (projectId) formData.append("projectId", projectId);

      const res = await fetch("/api/photos/upload", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || "Nahrání fotky se nezdařilo");
      }

      const data = await res.json();
      const newPhoto: PhotoItem = {
        id: data.id || Date.now().toString(),
        url: data.url || URL.createObjectURL(selectedFile),
        name: selectedFile.name,
      };

      setPhotos((prev) => [...prev, newPhoto]);
      setSelectedFile(null);
    } catch (err) {
      console.error("Photo upload error:", err);
      setError(err instanceof Error ? err.message : "Nahrání fotky se nezdařilo");
    }
  };

  const handleSignAndLock = async () => {
    if (!window.confirm("Opravdu chcete denní záznam podepsat a uzamknout?")) return;

    try {
      const res = await fetch(`/api/projects/${projectId}/reports/${reportId}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signed: true }),
      });
      if (res.ok) {
        setIsSigned(true);
        setError("");
      } else {
        setError(await readError(res, "Záznam se nepodařilo podepsat"));
      }
    } catch (err) {
      console.error("Failed to sign report:", err);
      setError("Záznam se nepodařilo podepsat");
    }
  };

  const handleAcknowledge = async () => {
    if (!window.confirm("Potvrdit seznámení se záznamem?")) return;

    try {
      const res = await fetch(`/api/projects/${projectId}/reports/${reportId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged: true }),
      });
      if (res.ok) {
        setIsAcknowledged(true);
        setError("");
      } else {
        setError(await readError(res, "Záznam se nepodařilo potvrdit"));
      }
    } catch (err) {
      console.error("Failed to acknowledge report:", err);
      setError("Záznam se nepodařilo potvrdit");
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      {/* Header and status badges */}
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <div className="flex items-center gap-2">
              <Link to={`/projects/${projectId}?tab=reports`} className="text-sm text-indigo-600 hover:underline">
                ← Zpět na seznam záznamů
              </Link>
            </div>
            <h1 className="mt-2 text-2xl font-bold text-gray-900">Denní záznam stavby: {reportId}</h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isControlDay && <span className="rounded bg-purple-100 px-2.5 py-1 text-xs font-semibold text-purple-800">Kontrolní den</span>}
            {constructionObj && <span className="rounded bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-800">SO: {constructionObj}</span>}
            {isSigned && <span className="rounded bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-800">Podepsáno</span>}
            {isAcknowledged && <span className="rounded bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">Potvrzeno investorem</span>}
          </div>
        </div>

        {/* Investor Acknowledgment Button: only a signed (locked) report can be acknowledged */}
        {isInvestor && isSigned && !isAcknowledged && (
          <div className="mt-4 flex justify-end border-t border-gray-200 pt-4">
            <button type="button" onClick={handleAcknowledge} className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700">
              Potvrdit seznámení
            </button>
          </div>
        )}
      </div>

      {error && <div className="mb-4 rounded bg-red-100 p-3 text-sm text-red-700">{error}</div>}

      {/* Main Report Form */}
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <form onSubmit={handleCreateReport} className="space-y-6">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Popis prací</label>
            <textarea
              name="workDescription"
              value={workDescription}
              onChange={(e) => setWorkDescription(e.target.value)}
              rows={4}
              required
              className="w-full rounded-md border border-gray-300 p-2 focus:border-indigo-500 focus:ring-indigo-500"
              placeholder="Popište provedené práce za dnešní den..."
            />
          </div>

          {/* Workers by trade */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Profese pracovníků</label>
              <input
                name="workerTrade"
                type="text"
                value={workerTrade}
                onChange={(e) => setWorkerTrade(e.target.value)}
                className="w-full rounded-md border border-gray-300 p-2"
                placeholder="např. Zedník"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Počet pracovníků</label>
              <input
                name="workerCount"
                type="number"
                value={workerCount}
                onChange={(e) => setWorkerCount(e.target.value)}
                className="w-full rounded-md border border-gray-300 p-2"
                placeholder="2"
              />
            </div>
          </div>

          {/* Legislative fields: Control Day & Construction Object */}
          <div className="grid grid-cols-1 gap-4 pt-2 md:grid-cols-2">
            <div className="flex items-center gap-2">
              <input
                name="isControlDay"
                id="isControlDay"
                type="checkbox"
                checked={isControlDay}
                onChange={(e) => setIsControlDay(e.target.checked)}
                className="h-4 w-4 rounded text-indigo-600"
              />
              <label htmlFor="isControlDay" className="text-sm font-medium text-gray-700">
                Dnes proběhla stavební kontrola
              </label>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Stavební objekt (SO)</label>
              <input
                name="constructionObj"
                type="text"
                value={constructionObj}
                onChange={(e) => setConstructionObj(e.target.value)}
                className="w-full rounded-md border border-gray-300 p-2"
                placeholder="např. SO-101"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 border-t border-gray-200 pt-4">
            <button
              type="submit"
              disabled={loadState !== "ready"}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Vytvořit záznam
            </button>
          </div>
        </form>
      </div>

      {/* Section 2: Photo upload and gallery */}
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-bold text-gray-900">Fotodokumentace</h2>

        <div className="mb-6 flex flex-wrap items-center gap-3">
          <input
            id="photo-files"
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="text-sm text-gray-500 file:mr-4 file:rounded-md file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-indigo-700 hover:file:bg-indigo-100"
          />
          <button
            type="button"
            disabled={!selectedFile}
            onClick={handleUploadPhoto}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
          >
            Nahrát fotky
          </button>
        </div>

        {photos.length > 0 && (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {photos.map((p, idx) => (
              <div key={p.id} className="rounded border bg-gray-50 p-2 text-center">
                <img src={p.url} alt={`Fotka ${idx + 1}`} className="mb-2 h-32 w-full rounded object-cover" />
                <span className="block truncate text-xs text-gray-600">{p.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Section 3: Sign & Lock */}
      {!isInvestor && (
        <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <div>
            <h3 className="font-semibold text-gray-900">Uzamčení a podpis denního záznamu</h3>
            <p className="text-xs text-gray-500">Po podepsání a uzamčení již záznam nelze dále editovat.</p>
          </div>
          <div>
            {!isSigned && (
              <button type="button" onClick={handleSignAndLock} className="rounded bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700">
                Podepsat a uzamknout
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
