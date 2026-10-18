import React, { useState, useEffect, useMemo, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { Addenda } from "../components/Addenda";
import { Remarks } from "../components/Remarks";
import { ApiError, api, apiFetch, currentUser, unsavedWorkIsKeptAsDraft } from "../lib/api";
import { isFutureDate, isLateEntryDate } from "../lib/dates";
import { DETAIL_FIELDS, emptyDetails, emptyForm, formFromEntry, keyOf, namesOf, temperatureOf, type Details, type FormValues, type WorkerRow } from "../lib/reportForm";
import { useReportDraft } from "../lib/useReportDraft";

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

/** The longest text of one field, as the server accepts it (EntryDetails.MAX_CHARS). */
const MAX_DETAIL_CHARS = 5000;

/** One party's acknowledgement of the signed entry, as the server lists it. */
interface Acknowledgement {
  userId: string;
  name: string;
  role: string;
  at: string;
}

/** What GET /api/reports/{id}/signature answers. */
interface SignatureCheck {
  signed: boolean;
  signedByName?: string | null;
  signerCkaitNumber?: string | null;
  signatureHash?: string | null;
  /** The content hashed again equals the recorded hash; null when there is nothing to compare with. */
  contentMatches: boolean | null;
  photoFilesMatch: boolean | null;
}

export const DailyReport: React.FC = () => {
  const { projectId, reportId } = useParams<{ projectId: string; reportId: string }>();

  // The role in THIS project decides what the page offers: investors and inspectors acknowledge, builders write and sign.
  // (The server decides in the end; this only keeps the page from offering what would be refused.)
  // undefined until the project has been asked: the form stays locked until then. A request that failed (a bad connection, a
  // server error) is no answer: the role stays unknown, the form stays locked and a retry is offered. Only the server saying
  // that the person has no access (403, 404) is the answer "no role".
  const [myRole, setMyRole] = useState<string | null | undefined>(undefined);
  const [roleFailed, setRoleFailed] = useState(false);
  const [roleTry, setRoleTry] = useState(0);
  const isInvestor = myRole === "INVESTOR" || myRole === "INSPECTOR";
  // Only the manager and the workers of the project write the daily entry (Rbac.kt, ReportCreate): for anybody else a save ends in 403.
  const canWrite = myRole === "BOSS" || myRole === "WORKER";
  useEffect(() => {
    if (!projectId) return;
    let ignore = false;
    api<{ myRole?: string | null }>(`/api/projects/${projectId}`)
      .then((p) => {
        if (ignore) return;
        setMyRole(p.myRole ?? null);
        setRoleFailed(false);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
          setMyRole(null);
          setRoleFailed(false);
        } else {
          setRoleFailed(true);
        }
      });
    return () => {
      ignore = true;
    };
  }, [projectId, roleTry]);
  const retryRole = () => {
    setRoleFailed(false);
    setRoleTry((n) => n + 1);
  };
  /** Shows a message and brings it into view, also when it is the same text as the last one (a repeated failed attempt). */
  const showError = (message: string) => {
    setError(message);
    setErrorTick((tick) => tick + 1);
  };
  const [error, setError] = useState("");

  // Report state
  // A new entry starts empty: invented defaults would end up in a legal record if nobody noticed them.
  const [workDescription, setWorkDescription] = useState<string>("");
  // One row per trade. The head count is entered, never defaulted: an invented number would end up in a legal record.
  const [workers, setWorkers] = useState<WorkerRow[]>([{ trade: "", count: "", names: "" }]);
  const [details, setDetails] = useState<Details>(emptyDetails());
  // Saving is only possible once it is known whether the day already has an entry: an unloaded form
  // must never be saved over an entry that exists.
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [isControlDay, setIsControlDay] = useState<boolean>(false);
  const [constructionObj, setConstructionObj] = useState<string>("");
  const [isSigned, setIsSigned] = useState<boolean>(false);
  // Signing asks for the password again; what a signature covers can be checked afterwards.
  const [entryId, setEntryId] = useState<string | null>(null);
  const [signatureHash, setSignatureHash] = useState<string | null>(null);
  // The number of the entry in the diary, given when it is signed.
  const [sequenceNumber, setSequenceNumber] = useState<number | null>(null);
  const [showSign, setShowSign] = useState(false);
  const [signPassword, setSignPassword] = useState("");
  const [signError, setSignError] = useState("");
  const [signing, setSigning] = useState(false);
  const [signatureCheck, setSignatureCheck] = useState<SignatureCheck | null>(null);
  // Each party that took note of the signed entry (technical supervision, author's supervision, the client, ...).
  const [acknowledgements, setAcknowledgements] = useState<Acknowledgement[]>([]);
  const meId = currentUser()?.id;
  // Whose draft this page keeps: the person who opened it. Fixed here; another tab may sign somebody else in later.
  const [draftUserId] = useState(() => currentUser()?.id);
  const iAcknowledged = acknowledgements.some((a) => a.userId === meId);
  // The version of the entry as this form last saw it (null for a day without an entry). Sent back on save, so a
  // second person's changes are not overwritten without anybody noticing.
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState<boolean>(false);
  // The form is long: an error shown at its top is brought into view, wherever the person pressed Save.
  const errorBox = useRef<HTMLDivElement | null>(null);
  const [errorTick, setErrorTick] = useState(0);
  // A new entry for a day before the previous working day is a late entry (decision D10) and needs a reason.
  // The server decides; this only decides what the form shows. An existing entry shows what was recorded.
  // The weather is entered by hand (decision D12). Empty fields mean "not stated".
  const [weatherCondition, setWeatherCondition] = useState<string>("");
  const [weatherMin, setWeatherMin] = useState<string>("");
  const [weatherMax, setWeatherMax] = useState<string>("");
  const [lateEntryReason, setLateEntryReason] = useState<string>("");
  const [isLateEntry, setIsLateEntry] = useState<boolean>(false);
  // What the form holds (the same object until something is edited), and as one string: compared with the state it was
  // loaded or last saved in to know about unsaved changes.
  const values = useMemo<FormValues>(
    () => ({ workDescription, workers, isControlDay, constructionObj, weatherCondition, weatherMin, weatherMax, lateEntryReason, details }),
    [workDescription, workers, isControlDay, constructionObj, weatherCondition, weatherMin, weatherMax, lateEntryReason, details],
  );
  const formKey = useMemo(() => keyOf(values), [values]);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  // The form as the server showed it when the day was opened: what a draft is compared with.
  const [loadedForm, setLoadedForm] = useState<FormValues | null>(null);
  const dirty = savedKey !== null && formKey !== savedKey;
  // One save at a time: a second tap while the first is on its way would send a second create (and get a false conflict).
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  // When the form was last saved; shown until the next change.
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  useEffect(() => {
    if (error) errorBox.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [error, errorTick]);
  // Closing the tab, reloading or leaving the app with unsaved text: the browser asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const roleKnown = myRole !== undefined;
  // The draft of this day kept on the device (backlog B2): offered when the day opens if it holds what the stored entry
  // does not, written while there are unsaved changes, gone when they are saved. Not for a signed entry or a role that cannot write.
  // The hook also tells the application about unsaved work (setUnsavedWork): after a lapsed session the page must keep what
  // was typed (no reload, no redirect), and leaving the page (a link, logging out) asks first.
  const draft = useReportDraft({
    scope: draftUserId && projectId && reportId ? { userId: draftUserId, projectId, day: reportId } : null,
    ready: loadState === "ready",
    loaded: loadedForm,
    canWrite: roleKnown ? canWrite : null,
    isSigned,
    dirty,
    values,
    updatedAt,
  });
  // The form can be edited only once the entry is loaded (text typed earlier would be overwritten by the loaded one),
  // only by somebody who may write it, and not while a draft waits for the person to take it or throw it away.
  const editable = loadState === "ready" && roleKnown && canWrite && !isSigned && draft.offer === null;
  const needsLateReason = updatedAt === null && !!reportId && isLateEntryDate(reportId);
  const isFuture = !!reportId && isFutureDate(reportId);
  // A photo belongs to a saved, unsigned entry: the server attaches it to exactly the entry that is named.
  const canUploadPhoto = updatedAt !== null && !isSigned;

  // Photos
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  /** Puts [v] into the form (an entry as loaded from the server, or a draft the person took back). */
  const applyValues = (v: FormValues) => {
    setWorkDescription(v.workDescription);
    setDetails(v.details);
    setWorkers(v.workers);
    setIsControlDay(v.isControlDay);
    setConstructionObj(v.constructionObj);
    setWeatherCondition(v.weatherCondition);
    setWeatherMin(v.weatherMin);
    setWeatherMax(v.weatherMax);
    setLateEntryReason(v.lateEntryReason);
  };
  const handleRestoreDraft = () => {
    const restored = draft.restore();
    if (restored) applyValues(restored);
  };

  useEffect(() => {
    let ignore = false;
    if (projectId && reportId) {
      apiFetch(`/api/projects/${projectId}/reports/${reportId}`)
        .then((res) => {
          if (res.ok) return res.json();
          if (res.status === 404) return null; // no entry for this day yet: an empty form is right
          throw new Error(`Záznam se nepodařilo načíst (${res.status})`);
        })
        .then((data) => {
          if (ignore) return;
          setLoadState("ready");
          if (!data) {
            setSavedKey(keyOf(emptyForm())); // no entry yet: the empty form is the saved state
            setLoadedForm(emptyForm());
            return;
          }
          const loaded = formFromEntry(data);
          applyValues(loaded);
          setLoadedForm(loaded);
          setUpdatedAt(typeof data.updatedAt === "string" ? data.updatedAt : null);
          setEntryId(typeof data.id === "string" ? data.id : null);
          setSignatureHash(typeof data.signatureHash === "string" ? data.signatureHash : null);
          setSequenceNumber(typeof data.sequenceNumber === "number" ? data.sequenceNumber : null);
          setIsLateEntry(Boolean(data.isLateEntry));
          setIsSigned(Boolean(data.isSigned || data.isLocked));
          setAcknowledgements(Array.isArray(data.acknowledgements) ? (data.acknowledgements as Acknowledgement[]) : []);
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
  const addWorker = () => setWorkers((rows) => [...rows, { trade: "", count: "", names: "" }]);
  const updateDetail = (key: string, value: string) => setDetails((current) => ({ ...current, [key]: value }));
  const removeWorker = (index: number) => setWorkers((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== index) : rows));

  const handleCreateReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editable || isFuture || savingRef.current) return;

    // A trade needs a name and a whole head count (0 is allowed); a row left completely empty is simply not a trade.
    const rows = workers.filter((r) => r.trade.trim() !== "" || r.count.trim() !== "" || r.names.trim() !== "");
    for (const r of rows) {
      if (r.trade.trim() === "") return showError("Doplňte název profese u zadaného počtu pracovníků");
      if (!/^\d{1,6}$/.test(r.count.trim())) return showError(`Zadejte počet pracovníků u profese "${r.trade.trim()}" (celé číslo od 0)`);
    }
    for (const field of DETAIL_FIELDS) {
      if ((details[field.key] ?? "").length > MAX_DETAIL_CHARS) {
        return showError(`Pole "${field.label}" může mít nejvýše ${MAX_DETAIL_CHARS} znaků (teď ${details[field.key].length})`);
      }
    }
    const submittedKey = formKey;

    savingRef.current = true;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/reports/${reportId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: reportId,
          workDescription,
          workersByTrade: JSON.stringify(
            rows.map((r) => {
              const names = namesOf(r.names);
              return { trade: r.trade.trim(), count: Number(r.count.trim()), ...(names.length > 0 ? { names } : {}) };
            }),
          ),
          // Always sent, every field: what the form shows is what is stored (an empty text clears the field).
          details,
          isControlDay,
          constructionObj,
          // A saved entry is changed only if nobody else changed it; a day that looked empty only if nobody created it meanwhile.
          ...(updatedAt ? { expectedUpdatedAt: updatedAt } : { expectNew: true }),
          ...(needsLateReason ? { lateEntryReason } : {}),
          // Always sent: what the form shows is what is stored (an empty weather clears it).
          weather: { condition: weatherCondition.trim() || undefined, tempMin: temperatureOf(weatherMin), tempMax: temperatureOf(weatherMax) },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setConflict(false);
        setSavedKey(submittedKey);
        setSavedAt(new Date());
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
        showError(body?.error || "Záznam se nepodařilo uložit");
      }
    } catch (err) {
      console.error("Failed to create report:", err);
      showError("Záznam se nepodařilo uložit");
    } finally {
      savingRef.current = false;
      setSaving(false);
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
      // The fields that say where the photo belongs come before the file, so the server knows before it reads the file.
      if (reportId) formData.append("reportId", reportId);
      if (projectId) formData.append("projectId", projectId);
      formData.append("photo", selectedFile);

      const res = await apiFetch("/api/photos/upload", {
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
      showError(err instanceof Error ? err.message : "Nahrání fotky se nezdařilo");
    }
  };

  /** Opens the signing dialog. A signature covers the stored version, so unsaved text must be saved first. */
  const handleSignAndLock = () => {
    // Unsaved text on the screen would not be part of the signature, and the page would say "signed" above words that were never signed.
    if (draft.offer) return showError("Nejdřív se rozhodněte, zda rozepsaný koncept obnovit, nebo zahodit.");
    if (dirty) return showError("Záznam má neuložené změny. Nejdřív jej uložte, aby se podepsalo to, co vidíte.");
    if (updatedAt === null) return showError("Záznam ještě není uložen. Nejdřív jej uložte.");
    setSignPassword("");
    setSignError("");
    setShowSign(true);
  };

  const handleConfirmSign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (signing) return;
    setSigning(true);
    setSignError("");
    try {
      const res = await apiFetch(`/api/projects/${projectId}/reports/${reportId}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedUpdatedAt: updatedAt, password: signPassword }),
      });
      if (res.ok) {
        setShowSign(false);
        setSignPassword("");
        setIsSigned(true);
        setConflict(false);
        setError("");
        // The hash and the signer are known to the server now: take them from there.
        const reloaded = await apiFetch(`/api/projects/${projectId}/reports/${reportId}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        if (reloaded) {
          setEntryId(typeof reloaded.id === "string" ? reloaded.id : entryId);
          setSignatureHash(typeof reloaded.signatureHash === "string" ? reloaded.signatureHash : null);
          setSequenceNumber(typeof reloaded.sequenceNumber === "number" ? reloaded.sequenceNumber : null);
        }
      } else {
        const body = await res.json().catch(() => null);
        if (res.status === 409 && body?.code === "STALE_VERSION") {
          // Somebody changed the entry after it was loaded here: what the signer sees is not what would be signed.
          setShowSign(false);
          setConflict(true);
          showError(body?.error || "Záznam se mezitím změnil");
        } else {
          // A wrong password, a missing ČKAIT number, too many attempts: said in the dialog, which stays open.
          setSignError(body?.error || "Záznam se nepodařilo podepsat");
        }
      }
    } catch (err) {
      setSignError(err instanceof Error ? err.message : "Záznam se nepodařilo podepsat");
    } finally {
      setSigning(false);
    }
  };

  const handleCheckSignature = async () => {
    if (!entryId) return;
    try {
      const res = await apiFetch(`/api/reports/${entryId}/signature`);
      if (!res.ok) throw new Error("Podpis se nepodařilo ověřit");
      setSignatureCheck((await res.json()) as SignatureCheck);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Podpis se nepodařilo ověřit");
    }
  };

  const handleAcknowledge = async () => {
    if (!window.confirm("Potvrdit seznámení se záznamem?")) return;

    try {
      const res = await apiFetch(`/api/projects/${projectId}/reports/${reportId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged: true }),
      });
      if (res.ok) {
        // Take the list from the server: it knows the others, and the order.
        const reloaded = await apiFetch(`/api/projects/${projectId}/reports/${reportId}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        if (reloaded && Array.isArray(reloaded.acknowledgements)) setAcknowledgements(reloaded.acknowledgements as Acknowledgement[]);
        setError("");
      } else {
        showError(await readError(res, "Záznam se nepodařilo potvrdit"));
      }
    } catch (err) {
      console.error("Failed to acknowledge report:", err);
      showError("Záznam se nepodařilo potvrdit");
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
            {sequenceNumber !== null && <span className="rounded bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-800">Záznam č. {sequenceNumber}</span>}
            {acknowledgements.map((a) => (
              <span key={a.userId} className="rounded bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                Seznámil(a) se: {a.name} ({a.role === "INVESTOR" ? "stavebník" : "dozor"})
              </span>
            ))}
          </div>
        </div>

        {/* Investor Acknowledgment Button: only a signed (locked) report can be acknowledged */}
        {isInvestor && isSigned && !iAcknowledged && (
          <div className="mt-4 flex justify-end border-t border-gray-200 pt-4">
            <button type="button" onClick={handleAcknowledge} className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700">
              Potvrdit seznámení
            </button>
          </div>
        )}
      </div>

      {/* A draft kept on this device that the stored entry does not have: the form stays locked until the person decides */}
      {draft.offer && (
        <section aria-labelledby="draft-banner-title" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <h2 id="draft-banner-title" className="text-sm font-semibold text-amber-900">
            Našli jsme rozepsaný záznam
          </h2>
          <p className="mt-1 text-sm text-amber-900">
            V tomto zařízení je koncept z {draft.offer.savedAt.toLocaleString("cs-CZ", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}, který není v
            uloženém záznamu. Chcete v něm pokračovat?
          </p>
          {draft.offer.stale && (
            <p className="mt-1 text-sm font-medium text-amber-900">
              Záznam byl od té doby změněn (někým jiným nebo na jiném zařízení). Když koncept obnovíte a uložíte, přepíšete novější verzi.
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={handleRestoreDraft} className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700">
              Obnovit
            </button>
            <button type="button" onClick={draft.discard} className="rounded border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50">
              Zahodit
            </button>
          </div>
        </section>
      )}

      {error && (
        <div ref={errorBox} role="alert" className="mb-4 rounded bg-red-100 p-3 text-sm text-red-700">
          {error}
          {conflict && (
            <div className="mt-2">
              <button type="button" onClick={() => window.location.reload()} className="rounded bg-red-700 px-3 py-1 text-xs font-semibold text-white hover:bg-red-800">
                Načíst aktuální verzi
              </button>
              <span className="ml-2 text-xs">
                {unsavedWorkIsKeptAsDraft() ? "Co jste právě napsali, zůstane jako koncept a po načtení vám ho nabídneme." : "Co jste právě napsali, si před načtením zkopírujte."}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Main Report Form */}
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        {!roleKnown && roleFailed && (
          <div role="alert" className="rounded bg-red-100 p-3 text-sm text-red-700">
            Roli v projektu se nepodařilo zjistit, záznam proto zůstává zamčený.{" "}
            <button type="button" onClick={retryRole} className="rounded bg-red-700 px-3 py-1 text-xs font-semibold text-white hover:bg-red-800">
              Zkusit znovu
            </button>
          </div>
        )}
        {(loadState === "loading" || !roleKnown) && !roleFailed && (
          <p role="status" className="py-8 text-center text-sm text-gray-600">
            Načítám záznam…
          </p>
        )}
        <form onSubmit={handleCreateReport} hidden={loadState === "loading" || !roleKnown}>
          <fieldset disabled={!editable} className="m-0 min-w-0 space-y-6 border-0 p-0">
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
                    <input
                      name="workerNames"
                      type="text"
                      aria-label={`Jména pracovníků ${index + 1}`}
                      value={row.names}
                      onChange={(e) => updateWorker(index, { names: e.target.value })}
                      className="w-full rounded-md border border-gray-300 p-2 text-sm md:col-span-3"
                      placeholder="Jména pracovníků, oddělená středníkem (volitelné)"
                    />
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

            {/* The other fields the vyhláška asks a daily entry to say */}
            <div>
              <div className="mb-1 block text-sm font-medium text-gray-700">Další zápisy</div>
              <div className="space-y-3">
                {DETAIL_FIELDS.map((field) => (
                  <div key={field.key}>
                    <label htmlFor={`detail-${field.key}`} className="mb-1 block text-xs text-gray-600">
                      {field.label}
                    </label>
                    <textarea
                      id={`detail-${field.key}`}
                      name={`detail-${field.key}`}
                      value={details[field.key] ?? ""}
                      onChange={(e) => updateDetail(field.key, e.target.value)}
                      rows={2}
                      className="w-full rounded-md border border-gray-300 p-2 text-sm"
                      placeholder={field.placeholder}
                    />
                    {(details[field.key] ?? "").length > MAX_DETAIL_CHARS * 0.9 && (
                      <p className={`mt-1 text-xs ${(details[field.key] ?? "").length > MAX_DETAIL_CHARS ? "font-semibold text-red-700" : "text-gray-600"}`}>
                        {(details[field.key] ?? "").length} / {MAX_DETAIL_CHARS} znaků
                      </p>
                    )}
                  </div>
                ))}
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
            <div className="mt-6 space-y-2 border-t border-gray-200 pt-4 text-sm text-gray-600">
              <p>Záznam je podepsán a uzamčen. Opravy se vedou formou dodatků.</p>
              {signatureHash && (
                <p className="break-all">
                  Otisk obsahu (SHA-256): <span className="font-mono text-xs">{signatureHash}</span>
                </p>
              )}
              {entryId && (
                <button
                  type="button"
                  onClick={() => void handleCheckSignature()}
                  className="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  Ověřit podpis
                </button>
              )}
              {signatureCheck && (
                <div role="status" className={signatureCheck.contentMatches === false || signatureCheck.photoFilesMatch === false ? "text-red-700" : "text-green-700"}>
                  {signatureCheck.signedByName
                    ? `Podepsal ${signatureCheck.signedByName}${signatureCheck.signerCkaitNumber ? `, ČKAIT ${signatureCheck.signerCkaitNumber}` : ""}. `
                    : ""}
                  {signatureCheck.contentMatches === null
                    ? "Záznam byl podepsán dříve, než se otisk začal ukládat: není s čím porovnat."
                    : signatureCheck.contentMatches
                      ? "Obsah odpovídá podpisu."
                      : "POZOR: obsah záznamu se po podpisu změnil."}{" "}
                  {signatureCheck.photoFilesMatch === false ? "POZOR: soubor fotografie se po podpisu změnil." : ""}
                </div>
              )}
            </div>
          ) : roleKnown && !canWrite ? (
            <p className="mt-6 border-t border-gray-200 pt-4 text-sm text-gray-600">Záznam můžete jen číst; zapisují do něj stavbyvedoucí a pracovníci zhotovitele.</p>
          ) : (
            <div className="mt-6 flex items-center justify-end gap-3 border-t border-gray-200 pt-4">
              {dirty && <span className="text-xs text-amber-700">Neuložené změny</span>}
              {!dirty && !saving && savedAt && (
                <span role="status" className="text-xs text-green-700">
                  Uloženo {savedAt.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
              <button
                type="submit"
                disabled={!editable || isFuture || saving}
                className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "Ukládám…" : updatedAt === null ? "Uložit záznam" : "Uložit změny"}
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
            disabled={!canUploadPhoto}
            onChange={handleFileChange}
            className="text-sm text-gray-500 file:mr-4 file:rounded-md file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-indigo-700 hover:file:bg-indigo-100"
          />
          <button
            type="button"
            disabled={!selectedFile || !canUploadPhoto}
            onClick={handleUploadPhoto}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
          >
            Nahrát fotky
          </button>
          {updatedAt === null && <span className="text-xs text-amber-700">Fotky lze přidat po uložení záznamu.</span>}
          {isSigned && <span className="text-xs text-gray-600">Záznam je uzamčen, fotky už nelze přidávat.</span>}
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

      {/* Entries of other parties (supervision, the client, authorities): also on a signed entry */}
      {entryId && (
        <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm empty:hidden">
          <Remarks entryId={entryId} role={myRole ?? null} />
        </div>
      )}

      {/* Addenda: how a signed entry is corrected or completed */}
      {isSigned && entryId && (
        <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <Addenda entryId={entryId} canWrite={myRole === "BOSS" || myRole === "WORKER"} />
        </div>
      )}

      {showSign && (
        <div role="dialog" aria-modal="true" aria-labelledby="sign-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={(e) => void handleConfirmSign(e)} className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-xl">
            <h2 id="sign-title" className="text-lg font-bold text-gray-900">
              Podepsat a uzamknout záznam
            </h2>
            <p className="text-sm text-gray-600">
              Podepisujete uloženou verzi záznamu ze dne {reportId}. Po podpisu už záznam nejde změnit; opravy se vedou dodatky. K podpisu zadejte své heslo.
            </p>
            <div>
              <label htmlFor="sign-password" className="mb-1 block text-xs font-medium text-gray-700">
                Heslo
              </label>
              <input
                id="sign-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={signPassword}
                onChange={(e) => setSignPassword(e.target.value)}
                className="w-full rounded border border-gray-300 p-2 text-sm"
              />
            </div>
            {signError && (
              <div role="alert" className="text-sm text-red-600">
                {signError}
              </div>
            )}
            <div className="flex justify-end gap-2 border-t pt-3">
              <button type="button" onClick={() => setShowSign(false)} className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
                Zrušit
              </button>
              <button
                type="submit"
                disabled={signing || signPassword.length === 0}
                className="rounded bg-red-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Podepsat
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Section 3: Sign & Lock (the manager of this project signs) */}
      {myRole === "BOSS" && (
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
                  disabled={dirty || updatedAt === null || draft.offer !== null}
                  className="rounded bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Podepsat a uzamknout
                </button>
                {draft.offer ? (
                  <p className="mt-1 text-xs text-amber-700">Nejdřív se rozhodněte, zda rozepsaný koncept obnovit, nebo zahodit.</p>
                ) : (
                  (dirty || updatedAt === null) && <p className="mt-1 text-xs text-amber-700">Nejdřív záznam uložte, podepíše se uložená verze.</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * The route element of the entry page: [DailyReport] mounted once per project and day. When only the day in the URL changes
 * (the browser's history, a link to another day) React would otherwise keep the page, and one day's text would be
 * saved into another; with the key the page starts fresh for every day.
 */
export function DailyReportPage() {
  const { projectId, reportId } = useParams<{ projectId: string; reportId: string }>();
  return <DailyReport key={`${projectId}/${reportId}`} />;
}
