import React, { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { currentUser } from "../lib/api";
import { isFutureDate, isLateEntryDate } from "../lib/dates";

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

/** Suggestions for the weather field; any text is accepted. */
const WEATHER_CONDITIONS = ["jasno", "polojasno", "oblačno", "zataženo", "mlha", "přeháňky", "déšť", "bouřka", "sněžení", "silný vítr"];

/** A temperature field as the number the server expects, or undefined when it is empty. */
const temperature = (value: string): number | undefined => {
  const n = Number.parseFloat(value.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
};

interface WorkerRow {
  trade: string;
  count: string;
}

/** Everything the user can edit on the form. */
interface FormValues {
  workDescription: string;
  workers: WorkerRow[];
  isControlDay: boolean;
  constructionObj: string;
  weatherCondition: string;
  weatherMin: string;
  weatherMax: string;
  lateEntryReason: string;
}

const EMPTY_FORM: FormValues = {
  workDescription: "",
  workers: [{ trade: "", count: "" }],
  isControlDay: false,
  constructionObj: "",
  weatherCondition: "",
  weatherMin: "",
  weatherMax: "",
  lateEntryReason: "",
};

/** The form as one string: compared with the state it was loaded or last saved in, to know about unsaved changes. */
const keyOf = (v: FormValues): string => JSON.stringify(v);

export const DailyReport: React.FC = () => {
  const { projectId, reportId } = useParams<{ projectId: string; reportId: string }>();

  // User role: investors and inspectors acknowledge, builders write and sign.
  const me = currentUser();
  const isInvestor = me?.role === "INVESTOR" || me?.role === "INSPECTOR";
  const [error, setError] = useState("");

  // Report state
  // A new entry starts empty: invented defaults would end up in a legal record if nobody noticed them.
  const [workDescription, setWorkDescription] = useState<string>("");
  // One row per trade. The head count is entered, never defaulted: an invented number would end up in a legal record.
  const [workers, setWorkers] = useState<WorkerRow[]>([{ trade: "", count: "" }]);
  // Saving is only possible once it is known whether the day already has an entry: an unloaded form
  // must never be saved over an entry that exists.
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [isControlDay, setIsControlDay] = useState<boolean>(false);
  const [constructionObj, setConstructionObj] = useState<string>("");
  const [isSigned, setIsSigned] = useState<boolean>(false);
  const [isAcknowledged, setIsAcknowledged] = useState<boolean>(false);
  // The version of the entry as this form last saw it (null for a day without an entry). Sent back on save, so a
  // second person's changes are not overwritten without anybody noticing.
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState<boolean>(false);
  // A new entry for a day before the previous working day is a late entry (decision D10) and needs a reason.
  // The server decides; this only decides what the form shows. An existing entry shows what was recorded.
  // The weather is entered by hand (decision D12). Empty fields mean "not stated".
  const [weatherCondition, setWeatherCondition] = useState<string>("");
  const [weatherMin, setWeatherMin] = useState<string>("");
  const [weatherMax, setWeatherMax] = useState<string>("");
  const [lateEntryReason, setLateEntryReason] = useState<string>("");
  const [isLateEntry, setIsLateEntry] = useState<boolean>(false);
  // What the form holds, as one string: compared with the state it was loaded or last saved in to know about unsaved changes.
  const formKey = keyOf({ workDescription, workers, isControlDay, constructionObj, weatherCondition, weatherMin, weatherMax, lateEntryReason });
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const dirty = savedKey !== null && formKey !== savedKey;
  const needsLateReason = updatedAt === null && !!reportId && isLateEntryDate(reportId);
  const isFuture = !!reportId && isFutureDate(reportId);

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
          if (!data) {
            setSavedKey(keyOf(EMPTY_FORM)); // no entry yet: the empty form is the saved state
            return;
          }
          let loadedWorkers: WorkerRow[] = EMPTY_FORM.workers;
          try {
            const trades = typeof data.workersByTrade === "string" ? JSON.parse(data.workersByTrade) : data.workersByTrade;
            if (Array.isArray(trades) && trades.length > 0) {
              loadedWorkers = trades.map((t: { trade?: unknown; count?: unknown }) => ({
                trade: typeof t.trade === "string" ? t.trade : "",
                count: typeof t.count === "number" ? String(t.count) : "",
              }));
            }
          } catch {
            // keep the empty row
          }
          const loaded: FormValues = {
            workDescription: typeof data.workDescription === "string" ? data.workDescription : "",
            workers: loadedWorkers,
            isControlDay: Boolean(data.isControlDay),
            constructionObj: typeof data.constructionObj === "string" ? data.constructionObj : "",
            weatherCondition: typeof data.weather?.condition === "string" ? data.weather.condition : "",
            weatherMin: typeof data.weather?.tempMin === "number" ? String(data.weather.tempMin) : "",
            weatherMax: typeof data.weather?.tempMax === "number" ? String(data.weather.tempMax) : "",
            lateEntryReason: typeof data.lateEntryReason === "string" ? data.lateEntryReason : "",
          };
          setWorkDescription(loaded.workDescription);
          setWorkers(loaded.workers);
          setIsControlDay(loaded.isControlDay);
          setConstructionObj(loaded.constructionObj);
          setWeatherCondition(loaded.weatherCondition);
          setWeatherMin(loaded.weatherMin);
          setWeatherMax(loaded.weatherMax);
          setLateEntryReason(loaded.lateEntryReason);
          setUpdatedAt(typeof data.updatedAt === "string" ? data.updatedAt : null);
          setIsLateEntry(Boolean(data.isLateEntry));
          setIsSigned(Boolean(data.isSigned || data.isLocked));
          setIsAcknowledged(Boolean(data.isAcknowledged));
          setSavedKey(keyOf(loaded));
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

  const updateWorker = (index: number, patch: Partial<WorkerRow>) => setWorkers((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const addWorker = () => setWorkers((rows) => [...rows, { trade: "", count: "" }]);
  const removeWorker = (index: number) => setWorkers((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== index) : rows));

  const handleCreateReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loadState !== "ready" || isFuture || isSigned) return;

    // A trade needs a name and a whole head count (0 is allowed); a row left completely empty is simply not a trade.
    const rows = workers.filter((r) => r.trade.trim() !== "" || r.count.trim() !== "");
    for (const r of rows) {
      if (r.trade.trim() === "") return setError("Doplňte název profese u zadaného počtu pracovníků");
      if (!/^\d{1,6}$/.test(r.count.trim())) return setError(`Zadejte počet pracovníků u profese "${r.trade.trim()}" (celé číslo od 0)`);
    }
    const submittedKey = formKey;

    try {
      const res = await fetch(`/api/projects/${projectId}/reports/${reportId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: reportId,
          workDescription,
          workersByTrade: JSON.stringify(rows.map((r) => ({ trade: r.trade.trim(), count: Number(r.count.trim()) }))),
          isControlDay,
          constructionObj,
          // A saved entry is changed only if nobody else changed it; a day that looked empty only if nobody created it meanwhile.
          ...(updatedAt ? { expectedUpdatedAt: updatedAt } : { expectNew: true }),
          ...(needsLateReason ? { lateEntryReason } : {}),
          // Always sent: what the form shows is what is stored (an empty weather clears it).
          weather: { condition: weatherCondition.trim() || undefined, tempMin: temperature(weatherMin), tempMax: temperature(weatherMax) },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setConflict(false);
        setSavedKey(submittedKey);
        if (data) {
          setUpdatedAt(typeof data.updatedAt === "string" ? data.updatedAt : null);
          setIsLateEntry(Boolean(data.isLateEntry));
          if (typeof data.lateEntryReason === "string") setLateEntryReason(data.lateEntryReason);
          if (data.isControlDay !== undefined) setIsControlDay(Boolean(data.isControlDay));
          if (data.constructionObj) setConstructionObj(data.constructionObj);
          if (data.isSigned !== undefined) setIsSigned(Boolean(data.isSigned || data.isLocked));
        }
        setError("");
      } else {
        const body = await res.json().catch(() => null);
        // Somebody else saved this entry after it was loaded here: offer to load their version.
        setConflict(res.status === 409 && body?.code === "STALE_VERSION");
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
    // A signature covers the stored version. Unsaved text on the screen would not be part of it, and the page would say
    // "signed" above words that were never signed.
    if (dirty) return setError("Záznam má neuložené změny. Nejdřív jej uložte, aby se podepsalo to, co vidíte.");
    if (updatedAt === null) return setError("Záznam ještě není uložen. Nejdřív jej uložte.");
    if (!window.confirm("Opravdu chcete denní záznam podepsat a uzamknout?")) return;

    try {
      const res = await fetch(`/api/projects/${projectId}/reports/${reportId}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signed: true, expectedUpdatedAt: updatedAt }),
      });
      if (res.ok) {
        setIsSigned(true);
        setConflict(false);
        setError("");
      } else {
        const body = await res.json().catch(() => null);
        // Somebody changed the entry after it was loaded here: what the signer sees is not what would be signed.
        setConflict(res.status === 409 && body?.code === "STALE_VERSION");
        setError(body?.error || "Záznam se nepodařilo podepsat");
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
            {isLateEntry && <span className="rounded bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">Pozdní zápis</span>}
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

      {error && (
        <div role="alert" className="mb-4 rounded bg-red-100 p-3 text-sm text-red-700">
          {error}
          {conflict && (
            <div className="mt-2">
              <button type="button" onClick={() => window.location.reload()} className="rounded bg-red-700 px-3 py-1 text-xs font-semibold text-white hover:bg-red-800">
                Načíst aktuální verzi
              </button>
              <span className="ml-2 text-xs">Co jste právě napsali, si před načtením zkopírujte.</span>
            </div>
          )}
        </div>
      )}

      {/* Main Report Form */}
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <form onSubmit={handleCreateReport}>
          <fieldset disabled={isSigned} className="m-0 min-w-0 space-y-6 border-0 p-0">
            {isFuture && (
              <div role="alert" className="rounded bg-red-100 p-3 text-sm text-red-700">
                Záznam nelze založit pro budoucí datum.
              </div>
            )}
            {needsLateReason && (
              <div className="rounded border border-amber-300 bg-amber-50 p-3">
                <label htmlFor="lateEntryReason" className="mb-1 block text-sm font-semibold text-amber-900">
                  Pozdní zápis: uveďte důvod
                </label>
                <p className="mb-2 text-xs text-amber-900">
                  Záznam je za den dřívější než předchozí pracovní den. Bude označen jako pozdní zápis a důvod zůstane součástí záznamu.
                </p>
                <textarea
                  id="lateEntryReason"
                  name="lateEntryReason"
                  value={lateEntryReason}
                  onChange={(e) => setLateEntryReason(e.target.value)}
                  rows={2}
                  required
                  maxLength={1000}
                  className="w-full rounded-md border border-amber-300 p-2"
                />
              </div>
            )}
            {isLateEntry && lateEntryReason && (
              <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <span className="font-semibold">Důvod pozdního zápisu:</span> {lateEntryReason}
              </div>
            )}
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

            {/* Workers by trade: one row per trade */}
            <div>
              <div className="mb-1 block text-sm font-medium text-gray-700">Pracovníci podle profesí</div>
              <div className="space-y-2">
                {workers.map((row, index) => (
                  <div key={index} className="grid grid-cols-1 items-center gap-2 md:grid-cols-[1fr_9rem_auto]">
                    <input
                      name="workerTrade"
                      type="text"
                      aria-label={`Profese ${index + 1}`}
                      value={row.trade}
                      onChange={(e) => updateWorker(index, { trade: e.target.value })}
                      className="w-full rounded-md border border-gray-300 p-2"
                      placeholder="např. Zedník"
                    />
                    <input
                      name="workerCount"
                      type="number"
                      min={0}
                      step={1}
                      aria-label={`Počet pracovníků ${index + 1}`}
                      value={row.count}
                      onChange={(e) => updateWorker(index, { count: e.target.value })}
                      className="w-full rounded-md border border-gray-300 p-2"
                      placeholder="počet"
                    />
                    {workers.length > 1 ? (
                      <button type="button" onClick={() => removeWorker(index)} className="text-sm text-red-600 hover:text-red-800">
                        Odebrat
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                ))}
              </div>
              <button type="button" onClick={addWorker} className="mt-2 text-sm text-indigo-600 hover:underline">
                + Přidat profesi
              </button>
            </div>

            {/* Weather, entered by hand */}
            <div>
              <div className="mb-1 block text-sm font-medium text-gray-700">Počasí</div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div>
                  <label htmlFor="weatherCondition" className="mb-1 block text-xs text-gray-600">
                    Podmínky
                  </label>
                  <input
                    id="weatherCondition"
                    name="weatherCondition"
                    type="text"
                    list="weather-conditions"
                    maxLength={200}
                    value={weatherCondition}
                    onChange={(e) => setWeatherCondition(e.target.value)}
                    className="w-full rounded-md border border-gray-300 p-2"
                    placeholder="např. zataženo"
                  />
                  <datalist id="weather-conditions">
                    {WEATHER_CONDITIONS.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label htmlFor="weatherMin" className="mb-1 block text-xs text-gray-600">
                    Nejnižší teplota (°C)
                  </label>
                  <input
                    id="weatherMin"
                    name="weatherMin"
                    type="number"
                    step="0.5"
                    min={-60}
                    max={60}
                    value={weatherMin}
                    onChange={(e) => setWeatherMin(e.target.value)}
                    className="w-full rounded-md border border-gray-300 p-2"
                  />
                </div>
                <div>
                  <label htmlFor="weatherMax" className="mb-1 block text-xs text-gray-600">
                    Nejvyšší teplota (°C)
                  </label>
                  <input
                    id="weatherMax"
                    name="weatherMax"
                    type="number"
                    step="0.5"
                    min={-60}
                    max={60}
                    value={weatherMax}
                    onChange={(e) => setWeatherMax(e.target.value)}
                    className="w-full rounded-md border border-gray-300 p-2"
                  />
                </div>
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
          </fieldset>

          {isSigned ? (
            <p className="mt-6 border-t border-gray-200 pt-4 text-sm text-gray-600">Záznam je podepsán a uzamčen. Opravy se vedou formou dodatků.</p>
          ) : (
            <div className="mt-6 flex items-center justify-end gap-3 border-t border-gray-200 pt-4">
              {dirty && <span className="text-xs text-amber-700">Neuložené změny</span>}
              <button
                type="submit"
                disabled={loadState !== "ready" || isFuture}
                className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Vytvořit záznam
              </button>
            </div>
          )}
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
              <div className="text-right">
                <button
                  type="button"
                  onClick={handleSignAndLock}
                  disabled={dirty || updatedAt === null}
                  className="rounded bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Podepsat a uzamknout
                </button>
                {(dirty || updatedAt === null) && <p className="mt-1 text-xs text-amber-700">Nejdřív záznam uložte, podepíše se uložená verze.</p>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
