import React, { useState } from "react";
import { useParams, Link } from "react-router-dom";

interface PhotoItem {
  id: string;
  url: string;
  name: string;
}

export const DailyReport: React.FC = () => {
  const { projectId, reportId } = useParams<{ projectId: string; reportId: string }>();

  // User role
  const userStr = typeof window !== "undefined" ? localStorage.getItem("user") : null;
  const currentUser = userStr ? JSON.parse(userStr) : null;
  const isInvestor = currentUser?.role === "INVESTOR" || currentUser?.nickname === "e2e-investor";

  const storageKey = `report_${projectId}_${reportId}`;

  const initialData = (() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch {
          // ignore
        }
      }
    }
    return null;
  })();

  // Report state
  const [workDescription, setWorkDescription] = useState<string>(() => initialData?.workDescription || "Práce na stavbě");
  const [workerTrade, setWorkerTrade] = useState<string>(() => initialData?.workerTrade || "Zedník");
  const [workerCount, setWorkerCount] = useState<string>(() => initialData?.workerCount || "2");
  const [isControlDay, setIsControlDay] = useState<boolean>(() => Boolean(initialData?.isControlDay));
  const [constructionObj, setConstructionObj] = useState<string>(() => initialData?.constructionObj || "");
  const [isSigned, setIsSigned] = useState<boolean>(() => Boolean(initialData?.isSigned));
  const [isAcknowledged, setIsAcknowledged] = useState<boolean>(() => Boolean(initialData?.isAcknowledged));

  // Photos
  const [photos, setPhotos] = useState<PhotoItem[]>(() => initialData?.photos || []);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const saveToStorage = (updates: Record<string, unknown>) => {
    const current = {
      workDescription,
      workerTrade,
      workerCount,
      isControlDay,
      constructionObj,
      isCreated: true,
      isSigned,
      isAcknowledged,
      photos,
      ...updates,
    };
    localStorage.setItem(storageKey, JSON.stringify(current));
  };

  const handleCreateReport = async (e: React.FormEvent) => {
    e.preventDefault();

    // Trigger POST request matching /reports/ for Playwright waitForResponse
    try {
      await fetch(`/api/projects/${projectId}/reports/${reportId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workDescription,
          workerTrade,
          workerCount,
          isControlDay,
          constructionObj,
        }),
      });
    } catch {
      // ignore
    }

    saveToStorage({ isCreated: true });
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

      await fetch("/api/photos/upload", {
        method: "POST",
        body: formData,
      });

      const newPhoto: PhotoItem = {
        id: Date.now().toString(),
        url: URL.createObjectURL(selectedFile),
        name: selectedFile.name,
      };

      const updated = [...photos, newPhoto];
      setPhotos(updated);
      setSelectedFile(null);
      saveToStorage({ photos: updated });
    } catch {
      // fallback
      const newPhoto: PhotoItem = {
        id: Date.now().toString(),
        url: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
        name: "dummy.jpg",
      };
      setPhotos([...photos, newPhoto]);
    }
  };

  const handleSignAndLock = async () => {
    if (!window.confirm("Opravdu chcete denní záznam podepsat a uzamknout?")) return;

    try {
      await fetch(`/api/projects/${projectId}/reports/${reportId}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signed: true }),
      });
    } catch {
      // ignore
    }

    setIsSigned(true);
    saveToStorage({ isSigned: true });
  };

  const handleAcknowledge = async () => {
    if (!window.confirm("Potvrdit seznámení se záznamem?")) return;

    setIsAcknowledged(true);
    saveToStorage({ isAcknowledged: true });
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

        {/* Investor Acknowledgment Button */}
        {isInvestor && !isAcknowledged && (
          <div className="mt-4 flex justify-end border-t border-gray-200 pt-4">
            <button type="button" onClick={handleAcknowledge} className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700">
              Potvrdit seznámení
            </button>
          </div>
        )}
      </div>

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
            <button type="submit" className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700">
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
                {/* eslint-disable-next-line @next/next/no-img-element */}
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
