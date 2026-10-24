import React, { useState, useEffect, useMemo, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { Addenda } from "../components/Addenda";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ControlDayBadge, EntryStateBadge, LateEntryBadge } from "../components/EntryBadges";
import { EntryDocument, SignatureCard, type SignatureCheck } from "../components/EntryDocument";
import { Remarks } from "../components/Remarks";
import { Button, Card, Field, FormActions, Modal, StalledNotice, StatusBadge, TextArea, TextInput } from "../components/ui";
import { ApiError, api, apiFetch, currentUser, unsavedWorkIsKeptAsDraft } from "../lib/api";
import { formatDay, formatDayWithWeekday, isFutureDate, isLateEntryDate } from "../lib/dates";
import { entryNumberLabel } from "../lib/entryDocument";
import { DETAIL_FIELDS, emptyDetails, emptyForm, formFromEntry, keyOf, namesOf, temperatureOf, type Details, type FormValues, type WorkerRow } from "../lib/reportForm";
import { usePageTitle } from "../lib/pageTitle";
import { useReportDraft } from "../lib/useReportDraft";
import { useStalled } from "../lib/useStalled";

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

/** Controls that belong together, named once for a screen reader (`fieldset` and `legend`); the form's own look, no box. */
function Group({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-1 p-0 text-sm font-medium text-ink">{legend}</legend>
      {children}
    </fieldset>
  );
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

/** The entry as `GET /api/projects/{id}/reports/{day}` sends it: only what the page reads outside the form (the document, the head). */
interface EntryView {
  id: string;
  date: string;
  authorName?: string | null;
  workDescription?: string | null;
  workersByTrade?: unknown;
  weatherText?: string | null;
  details?: Record<string, string> | null;
  isLateEntry?: boolean;
  lateEntryReason?: string | null;
  isSigned?: boolean;
  sequenceNumber?: number | null;
  signedAt?: string | null;
  signerName?: string | null;
  signerCkaitNumber?: string | null;
  signerFrozen?: boolean;
  /** A signature of format 3 that lacks the name or the number of its signer (a row changed behind the application). */
  signerIncomplete?: boolean;
  signatureHash?: string | null;
  /** The server's answer to "may the person who asks change this entry?": the rule of the save, not a guess from the role. */
  canEdit?: boolean;
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
  // The name of the project, for the head of the page; the same request as the role (empty until it has answered).
  const [projectName, setProjectName] = useState("");
  const isClientSide = myRole === "INVESTOR" || myRole === "INSPECTOR";
  // Only the manager and the workers of the project write the daily entry (Rbac.kt, ReportCreate): for anybody else a save ends in 403.
  const canWrite = myRole === "BOSS" || myRole === "WORKER";
  useEffect(() => {
    if (!projectId) return;
    let ignore = false;
    api<{ myRole?: string | null; name?: string }>(`/api/projects/${projectId}`)
      .then((p) => {
        if (ignore) return;
        setMyRole(p.myRole ?? null);
        setProjectName(typeof p.name === "string" ? p.name : "");
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
  // A refusal that is about ONE control of the form (a trade without a name, a text that is too long): the control it is about (its `id`)
  // and what is wrong. It is said under that control (tied to it with `aria-describedby`, announced as an alert), the control has the
  // focus, and it goes away with the next change of the form (it remembers the form it was about). What is about the whole save (the
  // server's refusal) is `error`, above the form.
  const [refusal, setRefusal] = useState<{ id: string; message: string; formKey: string } | null>(null);

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
  // The entry as the server last showed it (the document, the head, the signature card read it); null for a day without an entry.
  const [entry, setEntry] = useState<EntryView | null>(null);
  // The number of the entry in the diary, given when it is signed.
  const [sequenceNumber, setSequenceNumber] = useState<number | null>(null);
  const [showSign, setShowSign] = useState(false);
  // The question before an acknowledgement is written (state of the page's own: taken off the screen the moment it is answered).
  const [askingAcknowledge, setAskingAcknowledge] = useState(false);
  // After signing the entry is read again (the signer, the time and the number are known only to the server). When that fails
  // the signature card says so and offers to try again, instead of saying "loading" for ever.
  const [signatureReloadFailed, setSignatureReloadFailed] = useState(false);
  const [signPassword, setSignPassword] = useState("");
  const [signError, setSignError] = useState("");
  const [signing, setSigning] = useState(false);
  // The server has not answered the signature for a long time: the dialog says so, and can be closed (nobody knows whether it signed).
  const signStalled = useStalled(signing);
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
  // Whatever the person changes answers the refusal (it said what to change): it is shown only for the form it was about.
  const fieldError = refusal !== null && refusal.formKey === formKey ? refusal : null;
  const refuse = (id: string, message: string) => {
    setRefusal({ id, message, formKey });
    // after the message is drawn: the control (and its description) are what a screen reader reads next
    window.setTimeout(() => document.getElementById(id)?.focus(), 0);
  };
  const [savedKey, setSavedKey] = useState<string | null>(null);
  // The form as the server showed it when the day was opened: what a draft is compared with.
  const [loadedForm, setLoadedForm] = useState<FormValues | null>(null);
  // A signed entry has no form any more, so nothing in it is unsaved, whatever the form held when it was signed.
  const dirty = !isSigned && savedKey !== null && formKey !== savedKey;
  // One save at a time: a second tap while the first is on its way would send a second create (and get a false conflict).
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  // When the form was last saved; shown until the next change.
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  useEffect(() => {
    if (error) errorBox.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [error, errorTick]);
  // Closing the tab or reloading with unsaved text: the browser asks first. That is `AppLayout`'s one handler, which asks whenever a page
  // or a dialog says it holds unsaved work; this page says it through `useReportDraft` below (`setUnsavedWork(dirty)`).
  const roleKnown = myRole !== undefined;
  // Whether the person may change THIS entry. For an entry that exists the server says (`canEdit`: the rule of the save, so a worker
  // is not offered a form for the manager's entry, whose save would end in 403); for a day nobody has written the role does
  // (the manager and the workers may create it).
  const mayEditEntry = canWrite && (entry === null || entry.canEdit === true);
  // The draft of this day kept on the device (backlog B2): offered when the day opens if it holds what the stored entry
  // does not, written while there are unsaved changes, gone when they are saved. Not for a signed entry or a role that cannot write.
  // The hook also tells the application about unsaved work (setUnsavedWork): after a lapsed session the page must keep what
  // was typed (no reload, no redirect), and leaving the page (a link, logging out) asks first.
  const draft = useReportDraft({
    scope: draftUserId && projectId && reportId ? { userId: draftUserId, projectId, day: reportId } : null,
    ready: loadState === "ready",
    loaded: loadedForm,
    canWrite: roleKnown ? mayEditEntry : null,
    isSigned,
    dirty,
    values,
    updatedAt,
  });
  // The form can be edited only once the entry is loaded (text typed earlier would be overwritten by the loaded one),
  // only by somebody who may write it, and not while a draft waits for the person to take it or throw it away.
  const editable = loadState === "ready" && roleKnown && mayEditEntry && !isSigned && draft.offer === null;
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
          setEntry(data as EntryView);
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
      // The row's index in the form (not in the rows that say something), because that is what the controls are called.
      const index = workers.indexOf(r);
      if (r.trade.trim() === "") return refuse(`worker-trade-${index}`, "Doplňte název profese u zadaného počtu pracovníků");
      if (!/^\d{1,6}$/.test(r.count.trim())) return refuse(`worker-count-${index}`, `Zadejte počet pracovníků u profese "${r.trade.trim()}" (celé číslo od 0)`);
    }
    for (const field of DETAIL_FIELDS) {
      if ((details[field.key] ?? "").length > MAX_DETAIL_CHARS) {
        return refuse(`detail-${field.key}`, `Pole "${field.label}" může mít nejvýše ${MAX_DETAIL_CHARS} znaků (teď ${details[field.key].length})`);
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
          setEntry(data as EntryView);
          setEntryId(typeof data.id === "string" ? data.id : null);
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
      console.error("Záznam se nepodařilo uložit:", err);
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
      console.error("Nahrání fotky se nezdařilo:", err);
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

  /** Reads the signed entry again: the signer, the time, the number and the fingerprint are known to the server. False (and the card says so) when it fails. */
  const reloadSignedEntry = async (): Promise<boolean> => {
    setSignatureReloadFailed(false);
    const reloaded = await apiFetch(`/api/projects/${projectId}/reports/${reportId}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (!reloaded) {
      setSignatureReloadFailed(true);
      return false;
    }
    setEntryId(typeof reloaded.id === "string" ? reloaded.id : entryId);
    setEntry(reloaded as EntryView);
    setSequenceNumber(typeof reloaded.sequenceNumber === "number" ? reloaded.sequenceNumber : null);
    return true;
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
        await reloadSignedEntry();
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

  /**
   * The acknowledgement itself, once the question has been answered yes (the question stays open while this runs). A refusal throws
   * a message that the question says inside itself, where the person is looking; the page behind it stays as it was.
   */
  const acknowledge = async () => {
    try {
      const res = await apiFetch(`/api/projects/${projectId}/reports/${reportId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged: true }),
      });
      if (!res.ok) throw new Error(await readError(res, "Záznam se nepodařilo potvrdit"));
      // Take the list from the server: it knows the others, and the order.
      const reloaded = await apiFetch(`/api/projects/${projectId}/reports/${reportId}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (reloaded && Array.isArray(reloaded.acknowledgements)) setAcknowledgements(reloaded.acknowledgements as Acknowledgement[]);
      setError("");
    } catch (err) {
      // The server's own message (or the sign-in that is needed) is said as it is; a network that failed is said in words.
      if (!(err instanceof TypeError)) throw err;
      console.error("Seznámení se záznamem se nepodařilo uložit:", err);
      throw new Error("Záznam se nepodařilo potvrdit");
    }
  };

  // What the page shows of the entry. A signed entry, and any entry seen by somebody who cannot write, is a document (the form
  // stays for those who write an unsigned one: it prompts for what the decree asks). A day nobody wrote, seen by a reader, says so.
  const settled = loadState === "ready" && roleKnown;
  const showDocument = settled && entry !== null && (isSigned || !mayEditEntry);
  const showNoEntry = settled && entry === null && !canWrite;
  const entryState: "none" | "draft" | "signed" = isSigned ? "signed" : updatedAt !== null ? "draft" : "none";
  // After signing, the server's view of the entry is fetched again (the signer, the time and the number are known only to it).
  const signatureLoaded = entry?.isSigned === true;
  // Who may add a photo follows the role (Rbac `PhotoUpload`), not the author: a worker may add one to the manager's entry too.
  const showPhotoControls = !isSigned && !(roleKnown && !canWrite);
  const dayLabel = formatDayWithWeekday(entry?.date ?? reportId ?? "", "long");
  // "Záznam č. 5 / 28. 9. 2026 – Hala Brno – Stavební deník". The number is known once the entry is signed and read again; until then a signed entry is just "Záznam", a draft
  // is "Rozpracovaný záznam" and a day nobody has written is "Záznam" too: the title never says more than the page knows.
  const entryTitle = sequenceNumber !== null ? entryNumberLabel(sequenceNumber) : entryState === "draft" ? "Rozpracovaný záznam" : "Záznam";
  usePageTitle(`${entryTitle} / ${formatDay(entry?.date ?? reportId ?? "")}`, projectName);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:py-8">
      {/* The head: where this is (project, day), what it is (the number, the state) and what is noted on it */}
      <Card className="mb-6">
        <Link to={`/projects/${projectId}?tab=reports`} className="-ml-2 inline-flex min-h-11 items-center px-2 text-sm text-primary-ink hover:underline">
          ← Zpět na seznam záznamů
        </Link>
        {projectName && <p className="mt-1 text-sm font-medium text-ink-muted">{projectName}</p>}
        <h1 className="mt-1 text-2xl font-bold text-ink tabular-nums">Denní záznam stavby: {dayLabel}</h1>
        {entry?.authorName && <p className="mt-1 text-sm text-ink-muted">Autor: {entry.authorName}</p>}
        {loadState === "ready" && (
          <div role="group" aria-label="Stav záznamu" className="mt-3 flex flex-wrap items-center gap-2">
            <EntryStateBadge state={entryState} />
            {!(isSigned && sequenceNumber === null) && (
              <StatusBadge tone="neutral" className="tabular-nums">
                {entryNumberLabel(sequenceNumber)}
              </StatusBadge>
            )}
            {isLateEntry && <LateEntryBadge />}
            {isControlDay && <ControlDayBadge />}
            {constructionObj && (
              <StatusBadge tone="neutral" outlined>
                SO: {constructionObj}
              </StatusBadge>
            )}
            {acknowledgements.map((a) => (
              <StatusBadge key={a.userId} tone="neutral" outlined>
                Seznámil(a) se: {a.name} ({a.role === "INVESTOR" ? "stavebník" : "dozor"})
              </StatusBadge>
            ))}
          </div>
        )}
      </Card>

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
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={handleRestoreDraft}>Obnovit</Button>
            <Button variant="secondary" onClick={draft.discard}>
              Zahodit
            </Button>
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

      {/* The entry: a document for a signed one and for a reader, the form for whoever writes it */}
      <Card className="mb-6">
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
        {showDocument && entry && (
          <>
            <EntryDocument entry={entry} />
            {!isSigned && (
              <p className="mt-6 border-t border-line pt-4 text-sm text-ink-muted">
                {canWrite ? "Záznam může upravit jen jeho autor nebo stavbyvedoucí." : "Záznam můžete jen číst; zapisují do něj stavbyvedoucí a pracovníci zhotovitele."}
              </p>
            )}
          </>
        )}
        {showNoEntry && (
          <div className="space-y-2">
            <p className="text-ink">Za tento den zatím není žádný záznam.</p>
            <p className="text-sm text-ink-muted">Záznam můžete jen číst; zapisují do něj stavbyvedoucí a pracovníci zhotovitele.</p>
          </div>
        )}
        {!showDocument && !showNoEntry && (
          <form onSubmit={handleCreateReport} hidden={loadState === "loading" || !roleKnown}>
            <fieldset disabled={!editable} className="m-0 min-w-0 space-y-6 border-0 p-0">
              {isFuture && (
                <div role="alert" className="rounded bg-red-100 p-3 text-sm text-red-700">
                  Záznam nelze založit pro budoucí datum.
                </div>
              )}
              {needsLateReason && (
                <div className="rounded border border-amber-300 bg-amber-50 p-3">
                  <Field
                    id="lateEntryReason"
                    label="Pozdní záznam: uveďte důvod"
                    hint="Záznam je za den dřívější než předchozí pracovní den. Bude označen jako pozdní záznam a důvod zůstane součástí záznamu."
                  >
                    <TextArea name="lateEntryReason" value={lateEntryReason} onChange={(e) => setLateEntryReason(e.target.value)} rows={2} required maxLength={1000} />
                  </Field>
                </div>
              )}
              {isLateEntry && lateEntryReason && (
                <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  <span className="font-semibold">Důvod pozdního záznamu:</span> {lateEntryReason}
                </div>
              )}
              <Field id="workDescription" label="Popis prací" hint="Co se udělalo, v jakém rozsahu a v jakém pořadí.">
                <TextArea name="workDescription" value={workDescription} onChange={(e) => setWorkDescription(e.target.value)} rows={4} required />
              </Field>

              {/* Workers by trade: one row per trade */}
              <Group legend="Pracovníci podle profesí">
                <div className="space-y-3">
                  {workers.map((row, index) => {
                    // The one row a refusal is about (a trade without a name, a head count that is not a whole number): its control says so, and is described by it.
                    const problem = fieldError?.id === `worker-trade-${index}` || fieldError?.id === `worker-count-${index}` ? fieldError : null;
                    return (
                      <div key={index} className="grid grid-cols-1 items-center gap-2 md:grid-cols-[1fr_9rem_auto]">
                        <TextInput
                          id={`worker-trade-${index}`}
                          name="workerTrade"
                          type="text"
                          aria-label={`Profese ${index + 1}`}
                          aria-invalid={problem?.id === `worker-trade-${index}` ? true : undefined}
                          aria-describedby={problem ? `worker-problem-${index}` : undefined}
                          value={row.trade}
                          onChange={(e) => updateWorker(index, { trade: e.target.value })}
                          placeholder="např. Zedník"
                        />
                        <TextInput
                          id={`worker-count-${index}`}
                          name="workerCount"
                          type="number"
                          min={0}
                          step={1}
                          aria-label={`Počet pracovníků ${index + 1}`}
                          aria-invalid={problem?.id === `worker-count-${index}` ? true : undefined}
                          aria-describedby={problem ? `worker-problem-${index}` : undefined}
                          value={row.count}
                          onChange={(e) => updateWorker(index, { count: e.target.value })}
                          placeholder="počet"
                        />
                        {workers.length > 1 ? (
                          <Button type="button" variant="quiet" size="sm" onClick={() => removeWorker(index)} aria-label={`Odebrat profesi ${index + 1}`}>
                            Odebrat
                          </Button>
                        ) : (
                          <span />
                        )}
                        <TextInput
                          id={`worker-names-${index}`}
                          name="workerNames"
                          type="text"
                          aria-label={`Jména pracovníků ${index + 1}`}
                          value={row.names}
                          onChange={(e) => updateWorker(index, { names: e.target.value })}
                          className="md:col-span-3"
                          placeholder="Jména pracovníků, oddělená středníkem (volitelné)"
                        />
                        {problem && (
                          <p id={`worker-problem-${index}`} role="alert" className="text-sm font-medium text-danger-ink md:col-span-3">
                            {problem.message}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
                <Button type="button" variant="quiet" size="sm" onClick={addWorker} className="mt-2">
                  + Přidat profesi
                </Button>
              </Group>

              {/* Weather, entered by hand */}
              <Group legend="Počasí a stav staveniště">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <Field id="weatherCondition" label="Popis" hint="Počasí a stav staveniště slovy, např. zataženo, staveniště rozmoklé.">
                    <TextInput
                      name="weatherCondition"
                      type="text"
                      list="weather-conditions"
                      maxLength={200}
                      value={weatherCondition}
                      onChange={(e) => setWeatherCondition(e.target.value)}
                    />
                    <datalist id="weather-conditions">
                      {WEATHER_CONDITIONS.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                  </Field>
                  <Field id="weatherMin" label="Nejnižší teplota (°C)">
                    <TextInput name="weatherMin" type="number" step="0.5" min={-60} max={60} value={weatherMin} onChange={(e) => setWeatherMin(e.target.value)} />
                  </Field>
                  <Field id="weatherMax" label="Nejvyšší teplota (°C)">
                    <TextInput name="weatherMax" type="number" step="0.5" min={-60} max={60} value={weatherMax} onChange={(e) => setWeatherMax(e.target.value)} />
                  </Field>
                </div>
              </Group>

              {/* The other fields the vyhláška asks a daily entry to say: the label is the heading of the part in the printed entry, the hint says what the decree asks */}
              <Group legend="Další údaje">
                <div className="space-y-4">
                  {DETAIL_FIELDS.map((field) => {
                    const id = `detail-${field.key}`;
                    const length = (details[field.key] ?? "").length;
                    const tooLong = length > MAX_DETAIL_CHARS;
                    const nearLimit = length > MAX_DETAIL_CHARS * 0.9 && !tooLong;
                    // After a Save that was refused the refusal is said (an alert on the message; the focus is on the control); while typing, the text that is too long says so politely (a status).
                    const refused = fieldError?.id === id ? fieldError.message : undefined;
                    const live = tooLong ? `Text je příliš dlouhý: ${length} / ${MAX_DETAIL_CHARS} znaků.` : undefined;
                    return (
                      <Field key={field.key} id={id} label={field.label} hint={field.hint} error={refused ?? live} errorRole={refused ? "alert" : "status"}>
                        <TextArea
                          name={id}
                          value={details[field.key] ?? ""}
                          onChange={(e) => updateDetail(field.key, e.target.value)}
                          rows={2}
                          placeholder={field.placeholder}
                          aria-describedby={nearLimit ? `${id}-count` : undefined}
                        />
                        {nearLimit && (
                          <p id={`${id}-count`} className="mt-1 text-xs text-ink-muted">
                            {length} / {MAX_DETAIL_CHARS} znaků
                          </p>
                        )}
                      </Field>
                    );
                  })}
                </div>
              </Group>

              {/* Control day and construction object */}
              <div className="grid grid-cols-1 gap-4 pt-2 md:grid-cols-2">
                <div className="flex items-start gap-3">
                  <input
                    name="isControlDay"
                    id="isControlDay"
                    type="checkbox"
                    checked={isControlDay}
                    onChange={(e) => setIsControlDay(e.target.checked)}
                    aria-describedby="isControlDay-hint"
                    className="mt-1 h-4 w-4 rounded text-indigo-600"
                  />
                  <div>
                    <label htmlFor="isControlDay" className="text-sm font-medium text-ink">
                      Kontrolní den
                    </label>
                    <p id="isControlDay-hint" className="text-sm text-ink-muted">
                      Zaškrtněte, pokud se na stavbě konala kontrola.
                    </p>
                  </div>
                </div>
                <Field id="constructionObj" label="Stavební objekt (SO)">
                  <TextInput name="constructionObj" type="text" value={constructionObj} onChange={(e) => setConstructionObj(e.target.value)} placeholder="např. SO-101" />
                </Field>
              </div>
            </fieldset>

            {roleKnown && !canWrite ? (
              <p className="mt-6 border-t border-gray-200 pt-4 text-sm text-gray-600">Záznam můžete jen číst; zapisují do něj stavbyvedoucí a pracovníci zhotovitele.</p>
            ) : (
              <div className="mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-gray-200 pt-4">
                {dirty && <span className="text-xs text-amber-700">Neuložené změny</span>}
                {!dirty && !saving && savedAt && (
                  <span role="status" className="text-xs text-green-700">
                    Uloženo {savedAt.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
                <Button type="submit" disabled={!editable || isFuture || saving}>
                  {saving ? "Ukládám…" : updatedAt === null ? "Uložit záznam" : "Uložit změny"}
                </Button>
              </div>
            )}
          </form>
        )}
      </Card>

      {/* Photos: what the entry holds; the way to add one only while it is being written */}
      {!showNoEntry && (
        <Card className="mb-6">
          <h2 className="mb-4 text-lg font-bold text-ink">Fotodokumentace</h2>

          {showPhotoControls && (
            <div className="mb-6 flex flex-wrap items-center gap-3">
              <label htmlFor="photo-files" className="text-sm font-medium text-ink">
                Fotka k nahrání
              </label>
              <input
                id="photo-files"
                type="file"
                accept="image/*"
                disabled={!canUploadPhoto}
                aria-describedby={updatedAt === null ? "photo-files-hint" : undefined}
                onChange={handleFileChange}
                className="text-sm text-gray-500 file:mr-4 file:rounded-md file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-indigo-700 hover:file:bg-indigo-100"
              />
              <Button disabled={!selectedFile || !canUploadPhoto} onClick={handleUploadPhoto}>
                Nahrát fotky
              </Button>
              {updatedAt === null && (
                <span id="photo-files-hint" className="text-xs text-amber-700">
                  Fotky lze přidat po uložení záznamu.
                </span>
              )}
            </div>
          )}

          {photos.length > 0 ? (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {photos.map((p, idx) => (
                <div key={p.id} className="rounded border bg-gray-50 p-2 text-center">
                  <img src={p.url} alt={`Fotka ${idx + 1}`} className="mb-2 h-32 w-full rounded object-cover" />
                  <span className="block truncate text-xs text-gray-600">{p.name}</span>
                </div>
              ))}
            </div>
          ) : (
            !showPhotoControls && <p className="text-ink-muted">Bez fotografií.</p>
          )}
        </Card>
      )}

      {/* The signature: who, when, the number and the fingerprint of what was signed, in one place */}
      {isSigned && (
        <div className="mb-6">
          <SignatureCard
            signerName={entry?.signerName}
            signerCkaitNumber={entry?.signerCkaitNumber}
            signerFrozen={entry?.signerFrozen}
            signedAt={entry?.signedAt}
            sequenceNumber={sequenceNumber}
            signatureHash={entry?.signatureHash}
            loading={!signatureLoaded && !signatureReloadFailed}
            loadFailed={!signatureLoaded && signatureReloadFailed}
            onRetry={() => void reloadSignedEntry()}
            signerIncomplete={entry?.signerIncomplete}
            canCheck={Boolean(entryId)}
            check={signatureCheck}
            onCheck={() => void handleCheckSignature()}
          >
            {/* Only a signed (locked) entry can be acknowledged, by the builder (stavebník) and the supervision */}
            {isClientSide && !iAcknowledged && <Button onClick={() => setAskingAcknowledge(true)}>Potvrdit seznámení</Button>}
          </SignatureCard>
        </div>
      )}

      {/* Entries of other parties (supervision, the client, authorities): also on a signed entry */}
      {entryId && (
        <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm empty:hidden sm:p-6">
          <Remarks entryId={entryId} role={myRole ?? null} />
        </div>
      )}

      {/* Addenda: how a signed entry is corrected or completed */}
      {isSigned && entryId && (
        <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
          <Addenda entryId={entryId} canWrite={myRole === "BOSS" || myRole === "WORKER"} />
        </div>
      )}

      {/* Acknowledging is binding (it is written with the person's name and the time, and cannot be taken back): it is asked in a dialog of the application's own. */}
      {askingAcknowledge && (
        <ConfirmDialog
          title="Potvrdit seznámení?"
          confirmLabel="Potvrdit seznámení"
          cancelLabel="Zrušit"
          destructive={false}
          action={acknowledge}
          onDone={() => setAskingAcknowledge(false)}
          onCancel={() => setAskingAcknowledge(false)}
        >
          Potvrzujete, že jste se seznámil(a) se záznamem ze dne {formatDay(entry?.date ?? reportId ?? "")}. Potvrzení se zapíše s vaším jménem a časem a nejde vzít zpět.
        </ConfirmDialog>
      )}

      {/* The dialog is the application's Modal: focus stays inside it and the form behind it is inert, so nothing can be typed there while it is open. */}
      {showSign && (
        <Modal
          title="Podepsat a uzamknout záznam"
          description={`Podepisujete uloženou verzi záznamu ze dne ${reportId}. Po podpisu už záznam nejde změnit; opravy se vedou dodatky. K podpisu zadejte své heslo.`}
          onCancel={() => setShowSign(false)}
          dismissible={!signing || signStalled}
          footer={<FormActions formId="sign-form" submitLabel="Podepsat" submitVariant="danger" busy={signing} stalled={signStalled} canSubmit={signPassword.length > 0} />}
        >
          <form id="sign-form" onSubmit={(e) => void handleConfirmSign(e)} className="space-y-3">
            {/* The server's refusal (a wrong password, a changed entry) is the password field's error: announced at once and tied to it. */}
            <Field id="sign-password" label="Heslo" error={signError || undefined}>
              <TextInput type="password" autoComplete="current-password" autoFocus value={signPassword} onChange={(e) => setSignPassword(e.target.value)} />
            </Field>
            {signStalled && <StalledNotice>Nevíme, jestli se záznam podepsal. Zkontrolujte jeho stav po zavření dialogu, než podpis zopakujete.</StalledNotice>}
          </form>
        </Modal>
      )}

      {/* Sign & lock (the manager of this project signs); a signed entry has its signature card above instead */}
      {myRole === "BOSS" && !isSigned && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-ink">Uzamčení a podpis denního záznamu</h2>
            <p className="text-xs text-ink-muted">Po podepsání a uzamčení již záznam nelze dále editovat.</p>
          </div>
          <div className="text-right">
            <Button variant="danger" onClick={handleSignAndLock} disabled={dirty || updatedAt === null || draft.offer !== null}>
              Podepsat a uzamknout
            </Button>
            {draft.offer ? (
              <p className="mt-1 text-xs text-amber-700">Nejdřív se rozhodněte, zda rozepsaný koncept obnovit, nebo zahodit.</p>
            ) : (
              (dirty || updatedAt === null) && <p className="mt-1 text-xs text-amber-700">Nejdřív záznam uložte, podepíše se uložená verze.</p>
            )}
          </div>
        </Card>
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
