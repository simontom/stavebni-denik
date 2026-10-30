import { useEffect, useId, useRef, useState } from "react";
import { ApiError, apiFetch } from "../lib/api";
import { formatDay } from "../lib/dates";
import { describeChanges, isSignPreview, shortDigest, viewOf, type PartAPersonRow, type PartAView, type SignPreview } from "../lib/signPreview";
import { useStalled } from "../lib/useStalled";
import { Banner, Button, Field, FormActions, Modal, StalledNotice, TextInput, type ModalHandle } from "./ui";

/** What the dialog says when the part A it showed is not the one that would be signed now. */
const PART_A_CHANGED = "Údaje o stavbě se mezi tím změnily; zkontrolujte je znovu.";
const PART_A_NOT_LOADED = "Údaje o stavbě se nepodařilo načíst.";

/** How many of the changes the notice lists; the rest is "a další změny" (the block below shows all of it). */
const MAX_CHANGES_LISTED = 6;

type Load = { state: "loading" } | { state: "ready"; preview: SignPreview } | { state: "failed"; message: string };

/** Asks the server for part A as it would be signed now. A refusal (a worker, a signed entry, no ČKAIT number) is its own message. */
async function loadPreview(path: string): Promise<Load> {
  try {
    const res = await apiFetch(path);
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) return isSignPreview(body) ? { state: "ready", preview: body } : { state: "failed", message: PART_A_NOT_LOADED };
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : PART_A_NOT_LOADED;
    return { state: "failed", message };
  } catch (err) {
    // A session that ended is said as it is (its dialog opens on top of this one); a network that failed is said in words.
    return { state: "failed", message: err instanceof ApiError ? err.message : `${PART_A_NOT_LOADED} Zkontrolujte připojení a zkuste to znovu.` };
  }
}

/**
 * The dialog that signs an entry (backlog C2b). A signature freezes part A of the diary (the identification, the persons with their
 * scope, the authorised persons) under the signer's ČKAIT number, so **the signer sees it first**: the dialog loads part A as the
 * server would freeze it now (`GET …/sign-preview`), shows it above the password, and the request names the SHA-256 of what was shown
 * (`expectedPartASha256`). When somebody changed it in between the server refuses (`409 STALE_VERSION`, nothing signed); the dialog then
 * loads part A again, says that it changed and what, and drops the password, so the person signs what they have read.
 *
 * A 409 can also mean that the entry itself changed (`expectedUpdatedAt`): when part A is as it was shown, that is what it is, and the
 * page is told ([onEntryChanged]) like before. The dialog follows the rules of the application's dialogs: the server's refusals are said
 * inside it, it cannot be dismissed while a request runs (and says that the server is silent after a while), a session that ends leaves
 * it where it is, and an answer closes it through its own handle so that the focus goes back.
 *
 * The focus starts on the block that holds part A, not on the password: on a phone the keyboard of a focused password field would cover
 * what is to be read.
 */
export function SignEntryDialog({
  projectId,
  reportId,
  day,
  updatedAt,
  onCancel,
  onSigned,
  onEntryChanged,
}: {
  projectId: string;
  /** The entry as the route names it (its day or its id). */
  reportId: string;
  /** The day of the entry, for the sentence that says what is signed. */
  day: string;
  /** The version of the entry the signer was looking at. */
  updatedAt: string;
  onCancel: () => void;
  /** The entry is signed; the page stops rendering the dialog. */
  onSigned: () => void;
  /** The entry changed after it was loaded (not part A): the server's message, for the page to say. The page stops rendering the dialog. */
  onEntryChanged: (message: string) => void;
}) {
  const base = `/api/projects/${projectId}/reports/${reportId}`;
  const previewPath = `${base}/sign-preview`;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ changes: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const stalled = useStalled(busy);
  // Counts the times part A was shown again after a change: the block is read from the top and has the focus again.
  const [shownAgain, setShownAgain] = useState(0);
  const modal = useRef<ModalHandle>(null);
  const region = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void loadPreview(previewPath).then((result) => {
      if (mounted.current) setLoad(result);
    });
    return () => {
      mounted.current = false;
    };
  }, [previewPath]);

  useEffect(() => {
    if (shownAgain === 0) return;
    region.current?.scrollTo?.({ top: 0 });
    region.current?.focus();
  }, [shownAgain]);

  const retry = () => {
    setLoad({ state: "loading" });
    void loadPreview(previewPath).then((result) => {
      if (mounted.current) setLoad(result);
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || load.state !== "ready" || password.length === 0) return;
    const shown = load.preview;
    setBusy(true);
    setError("");
    setNotice(null);
    try {
      const res = await apiFetch(`${base}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedUpdatedAt: updatedAt, expectedPartASha256: shown.partASha256, password }),
      });
      if (res.ok) {
        setPassword("");
        modal.current?.close(onSigned, { restoreFocus: true });
        return;
      }
      const body: { error?: unknown; code?: unknown } | null = await res.json().catch(() => null);
      const message = typeof body?.error === "string" ? body.error : null;
      if (res.status === 409 && body?.code === "STALE_VERSION") {
        // Something changed after it was loaded here. The password is never kept; part A is looked at again, and the answer says which it was.
        setPassword("");
        const fresh = await loadPreview(previewPath);
        if (!mounted.current) return;
        if (fresh.state === "ready" && fresh.preview.partASha256 !== shown.partASha256) {
          setLoad(fresh);
          setNotice({ changes: describeChanges(shown.partA, fresh.preview.partA) });
          setShownAgain((n) => n + 1);
        } else if (fresh.state === "ready") {
          // Part A is what was shown: it is the entry that changed, which the page says (and loads again).
          modal.current?.close(() => onEntryChanged(message ?? "Záznam se mezitím změnil"), { restoreFocus: true });
        } else {
          setLoad(fresh);
          setNotice({ changes: [] });
          setShownAgain((n) => n + 1);
        }
      } else {
        // A wrong password, a missing ČKAIT number, too many attempts: said at the password, in the dialog, which stays open.
        setError(message ?? "Záznam se nepodařilo podepsat");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Záznam se nepodařilo podepsat");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const ready = load.state === "ready";
  return (
    <Modal
      title="Podepsat a uzamknout záznam"
      description={`Podepisujete uloženou verzi záznamu ze dne ${formatDay(day)}. Po podpisu už záznam nejde změnit; opravy se vedou dodatky. K podpisu zadejte své heslo.`}
      size="lg"
      handleRef={modal}
      initialFocus={region}
      onCancel={onCancel}
      dismissible={!busy || stalled}
      footer={<FormActions formId="sign-form" submitLabel="Podepsat" submitVariant="danger" busy={busy} stalled={stalled} canSubmit={ready && password.length > 0} />}
    >
      <form id="sign-form" onSubmit={(e) => void submit(e)} className="space-y-3">
        {notice && (
          <Banner tone="warning" role="alert">
            <p className="font-semibold">{PART_A_CHANGED}</p>
            {notice.changes.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {notice.changes.slice(0, MAX_CHANGES_LISTED).map((change) => (
                  <li key={change}>{change}</li>
                ))}
                {notice.changes.length > MAX_CHANGES_LISTED && <li>a další změny</li>}
              </ul>
            )}
          </Banner>
        )}
        <PartABlock load={load} regionRef={region} onRetry={retry} />
        {/* The server's refusal (a wrong password, a lapsed session) is the password field's error: announced at once and tied to it. */}
        <Field id="sign-password" label="Heslo" error={error || undefined}>
          <TextInput type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {stalled && <StalledNotice>Nevíme, jestli se záznam podepsal. Zkontrolujte jeho stav po zavření dialogu, než podpis zopakujete.</StalledNotice>}
      </form>
    </Modal>
  );
}

/**
 * Part A as the signer reads it: a block that scrolls inside the dialog (and can be reached and scrolled from the keyboard), with the
 * digest and the sentence that these data become part of the signature under it. While part A is on its way, or could not be loaded, the
 * block says so, and the dialog has nothing to sign on.
 */
function PartABlock({ load, regionRef, onRetry }: { load: Load; regionRef: React.RefObject<HTMLDivElement | null>; onRetry: () => void }) {
  const headingId = useId();
  return (
    <div className="space-y-2">
      <div
        ref={regionRef}
        role="region"
        aria-labelledby={headingId}
        aria-busy={load.state === "loading"}
        tabIndex={0}
        className="max-h-[min(22rem,45dvh)] overflow-y-auto rounded-md border border-line bg-page p-3 text-sm"
      >
        <h3 id={headingId} className="mb-2 font-bold text-ink">
          Údaje o stavbě, které podepisujete
        </h3>
        {load.state === "loading" && <p className="text-ink-muted">Načítám údaje o stavbě…</p>}
        {load.state === "failed" && (
          <div className="space-y-2">
            <p role="alert" className="font-medium text-danger-ink">
              {load.message}
            </p>
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Načíst údaje o stavbě znovu
            </Button>
          </div>
        )}
        {load.state === "ready" && <PartAContent view={viewOf(load.preview.partA)} />}
      </div>
      {load.state === "ready" && (
        <div className="space-y-1 text-sm text-ink-muted">
          <p>
            Otisk údajů o stavbě:{" "}
            <code className="font-mono text-ink" title={load.preview.partASha256}>
              {shortDigest(load.preview.partASha256)}
            </code>
          </p>
          <p>Tyto údaje se podpisem uloží se záznamem a stanou se součástí podpisu; pozdější změna údajů o stavbě je nezmění.</p>
        </div>
      )}
    </div>
  );
}

function PartAContent({ view }: { view: PartAView }) {
  return (
    <div className="space-y-3">
      <dl className="space-y-1.5">
        <Fact label="Hlavní stavbyvedoucí" value={`${view.siteManager.name}, ${view.siteManager.ckait}`} />
        {view.facts.map((fact) => (
          <Fact key={fact.key} label={fact.label} value={fact.value} multiline={fact.multiline} />
        ))}
      </dl>
      <Persons title="Osoby zajišťující odborné vedení provádění stavby" rows={view.managers} />
      <Persons title="Dozor (technický dozor stavebníka, autorský dozor)" rows={view.supervisors} />
      <section>
        <h4 className="mb-1 font-semibold text-ink">Pověřené osoby (osoby oprávněné zapisovat do deníku, § 166 odst. 2)</h4>
        {view.authorizedPersons.length === 0 ? (
          <p className="text-ink-muted">žádné</p>
        ) : (
          <ul className="space-y-1.5">
            {view.authorizedPersons.map((person, index) => (
              <li key={index} className="break-words">
                <span className="font-medium text-ink">{person.name}</span>
                {person.company && <span>, {person.company}</span>}
                <div className="text-ink-muted">Funkce, rozsah pověření: {person.function ?? "neuvedeno"}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Fact({ label, value, multiline = false }: { label: string; value: string | null; multiline?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className={multiline ? "break-words whitespace-pre-line text-ink" : "break-words text-ink"}>{value ?? <span className="text-ink-muted">neuvedeno</span>}</dd>
    </div>
  );
}

function Persons({ title, rows }: { title: string; rows: PartAPersonRow[] }) {
  return (
    <section>
      <h4 className="mb-1 font-semibold text-ink">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-ink-muted">nikdo</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row, index) => (
            <li key={index} className="break-words">
              <span className="font-medium text-ink">{row.name}</span>
              {row.isSiteManager && <span> (hlavní stavbyvedoucí)</span>}, {row.ckait}
              <div className="text-ink-muted">Rozsah oprávnění a odpovědnosti: {row.scope ?? "neuvedeno"}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
