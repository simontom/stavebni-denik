import React, { useEffect, useRef, useState } from "react";
import { api, ApiError, currentUser, json, ROLE_LABELS, setUnsavedWork } from "../lib/api";
import { pragueToday } from "../lib/dates";
import {
  HANDOVER_LIMITS,
  SIDE_NAMES,
  canCreateHandover,
  canEditHandover,
  handoverProblem,
  signableSide,
  stateLabel,
  type Handover,
  type HandoverFormValues,
  type HandoverSide,
  type HandoverSignature,
  type Meter,
} from "../lib/handovers";
import { Banner, Button, Card, Field, Modal, PageState, StatusBadge, TextArea, TextInput, useModal } from "./ui";

/** A calendar day (`YYYY-MM-DD`) the way it is written in Czech: it is a day, not a moment, so no time zone is applied. */
function formatDay(day: string): string {
  const date = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString("cs-CZ", { timeZone: "UTC" });
}

/** A moment, in Prague time. */
function formatMoment(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("cs-CZ", { timeZone: "Europe/Prague" });
}

const limitHint = (n: number): string => `Nejvýše ${n.toLocaleString("cs-CZ").replace(/ /g, " ")} znaků`;

/**
 * The handovers of a project (předání a převzetí staveniště, příloha 12 B.2 a)): a protocol is an act of two parties and is signed
 * once by each (the contractor's manager, the client's investor or technical supervision). It can be changed until one of them
 * has signed; after that it is a document. The server decides who may do what (the role is read again inside the transaction);
 * this page only offers what the person's role allows.
 */
export function Handovers({ projectId, myRole }: { projectId: string; myRole?: string | null }) {
  const me = currentUser()?.id;
  const [handovers, setHandovers] = useState<Handover[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "warning" | "danger"; text: string; reload?: boolean } | null>(null);
  // The protocol being made or changed (null: the form is closed; `editing` null: a new one), and the one being signed.
  const [form, setForm] = useState<{ editing: Handover | null } | null>(null);
  const [signing, setSigning] = useState<{ handover: Handover; side: HandoverSide } | null>(null);

  // Bumped to load the list again (a retry, or the answer to a version that is out of date).
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let ignore = false;
    api<Handover[]>(`/api/projects/${projectId}/handovers`)
      .then((list) => {
        if (!ignore) setHandovers(list);
      })
      .catch((err: unknown) => {
        if (!ignore) setLoadError(err instanceof Error ? err.message : "Předání se nepodařilo načíst");
      });
    return () => {
      ignore = true;
    };
  }, [projectId, reloads]);

  const reload = () => {
    setHandovers(null);
    setLoadError("");
    setNotice(null);
    setReloads((n) => n + 1);
  };

  // After a signature the button that was used is gone (its side is signed), so the focus goes to the protocol that changed.
  const focusAfter = useRef<string | null>(null);
  useEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    document.getElementById(`handover-${id}`)?.focus();
  });

  const replace = (changed: Handover) => setHandovers((list) => (list ? list.map((h) => (h.id === changed.id ? changed : h)) : list));

  return (
    <Card>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-ink">Předání a převzetí staveniště</h2>
        {canCreateHandover(myRole) && handovers && <Button onClick={() => setForm({ editing: null })}>Přidat předání</Button>}
      </div>

      {notice && (
        <Banner tone={notice.tone} className="mb-4">
          <p>{notice.text}</p>
          {notice.reload && (
            <Button variant="secondary" size="sm" className="mt-2" onClick={reload}>
              Načíst aktuální stav
            </Button>
          )}
        </Banner>
      )}

      {loadError ? (
        <PageState
          kind="error"
          action={
            <Button variant="secondary" onClick={reload}>
              Zkusit znovu
            </Button>
          }
        >
          {loadError}
        </PageState>
      ) : handovers === null ? (
        <PageState kind="loading">Načítání předání…</PageState>
      ) : handovers.length === 0 ? (
        <p className="text-sm text-ink-muted">Zatím nebylo zaznamenáno žádné předání staveniště.</p>
      ) : (
        <ul className="space-y-4">
          {handovers.map((h) => (
            <HandoverCard
              key={h.id}
              handover={h}
              canEdit={canEditHandover(myRole, me, h)}
              signSide={signableSide(myRole, me, h)}
              onEdit={() => setForm({ editing: h })}
              onSign={(side) => setSigning({ handover: h, side })}
            />
          ))}
        </ul>
      )}

      {form && (
        <HandoverFormDialog
          projectId={projectId}
          editing={form.editing}
          onCancel={() => setForm(null)}
          onSaved={(saved) => {
            setForm(null);
            setNotice(null);
            setHandovers((list) => (form.editing ? (list ?? []).map((h) => (h.id === saved.id ? saved : h)) : [saved, ...(list ?? [])]));
          }}
        />
      )}

      {signing && (
        <SignDialog
          handover={signing.handover}
          side={signing.side}
          onCancel={() => setSigning(null)}
          onSigned={(signed) => {
            setSigning(null);
            focusAfter.current = signed.id;
            replace(signed);
            setNotice({ tone: "success", text: `Protokol „${signed.type}“ jste podepsal(a) za ${signing.side === "CONTRACTOR" ? "zhotovitele" : "stavebníka"}.` });
          }}
          onStale={(message) => {
            setSigning(null);
            setNotice({ tone: "warning", text: message, reload: true });
          }}
        />
      )}
    </Card>
  );
}

/** What a protocol says: the day, the participants, the meters and the notes. The same in the list and in the dialog that asks for a signature. */
function HandoverContent({ handover }: { handover: Handover }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-ink">{handover.participants}</p>
      <p className="text-xs text-ink-muted tabular-nums">{formatDay(handover.date)}</p>
      {handover.meterStates && handover.meterStates.length > 0 && (
        <div className="border-t border-line pt-3">
          <span className="text-xs font-semibold text-ink-muted">Stavy měřidel:</span>
          <div className="mt-1 flex flex-wrap gap-2 text-xs">
            {handover.meterStates.map((m, idx) => (
              <div key={idx} className="rounded border border-line bg-surface px-2 py-1">
                <span className="font-semibold">{m.medium}</span> ({m.serialNumber}): {m.state}
              </div>
            ))}
          </div>
        </div>
      )}
      {handover.notes && <p className="text-sm whitespace-pre-wrap text-ink">{handover.notes}</p>}
    </div>
  );
}

function SignatureLine({ side, signature }: { side: HandoverSide; signature?: HandoverSignature | null }) {
  const who = SIDE_NAMES[side].who;
  if (!signature) {
    return (
      <div className="text-sm">
        <dt className="font-semibold text-ink">{who}</dt>
        <dd className="text-ink-muted">Čeká na podpis</dd>
      </div>
    );
  }
  const role = ROLE_LABELS[signature.signerRole] ?? signature.signerRole;
  return (
    <div className="text-sm">
      <dt className="font-semibold text-ink">{who}</dt>
      <dd className="text-ink">
        Podepsal(a) {signature.signerName} ({role}
        {signature.signerCkaitNumber ? `, ČKAIT ${signature.signerCkaitNumber}` : ""}), <span className="tabular-nums">{formatMoment(signature.signedAt)}</span>
      </dd>
    </div>
  );
}

function HandoverCard({
  handover,
  canEdit,
  signSide,
  onEdit,
  onSign,
}: {
  handover: Handover;
  canEdit: boolean;
  signSide: HandoverSide | null;
  onEdit: () => void;
  onSign: (side: HandoverSide) => void;
}) {
  const state = stateLabel(handover.state);
  const contentHash = handover.contractorSignature?.contentHash ?? handover.clientSignature?.contentHash;
  return (
    <li
      id={`handover-${handover.id}`}
      tabIndex={-1}
      aria-labelledby={`handover-${handover.id}-title`}
      className="rounded-lg border border-line bg-page p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={`handover-${handover.id}-title`} className="font-bold text-ink">
          {handover.type}
        </h3>
        <StatusBadge tone={state.tone}>{state.text}</StatusBadge>
      </div>
      <div className="mt-2">
        <HandoverContent handover={handover} />
      </div>

      <dl className="mt-3 space-y-2 border-t border-line pt-3" aria-label="Podpisy">
        <SignatureLine side="CONTRACTOR" signature={handover.contractorSignature} />
        <SignatureLine side="CLIENT" signature={handover.clientSignature} />
      </dl>
      {contentHash && (
        <p className="mt-2 text-xs text-ink-muted">
          Otisk obsahu (SHA-256): <span className="font-mono">{contentHash}</span>. Podepsaný protokol už nelze změnit ani smazat.
        </p>
      )}

      {(canEdit || signSide) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {signSide && (
            <Button size="sm" onClick={() => onSign(signSide)}>
              {SIDE_NAMES[signSide].sign}
            </Button>
          )}
          {canEdit && (
            <Button size="sm" variant="secondary" onClick={onEdit}>
              Upravit
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** The buttons of a dialog's form: cancel closes the dialog while it is still in the document, so the focus can go back. */
function DialogButtons({ busy, canSubmit = true, submit, onCancel }: { busy: boolean; canSubmit?: boolean; submit: string; onCancel: () => void }) {
  const modal = useModal();
  return (
    <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">
      <Button variant="secondary" disabled={busy} onClick={() => modal.close(onCancel, { restoreFocus: true })}>
        Zrušit
      </Button>
      <Button type="submit" disabled={busy || !canSubmit}>
        {submit}
      </Button>
    </div>
  );
}

function HandoverFormDialog({ projectId, editing, onCancel, onSaved }: { projectId: string; editing: Handover | null; onCancel: () => void; onSaved: (saved: Handover) => void }) {
  const [saving, setSaving] = useState(false);
  return (
    <Modal title={editing ? "Upravit protokol o předání staveniště" : "Protokol o předání staveniště"} size="lg" onCancel={onCancel} dismissible={!saving}>
      <HandoverForm projectId={projectId} editing={editing} saving={saving} setSaving={setSaving} onCancel={onCancel} onSaved={onSaved} />
    </Modal>
  );
}

const DEFAULT_TYPE = "Předání staveniště zhotoviteli";

/** What the form holds for a protocol that is stored, or for a new one. */
const valuesOf = (h: Handover | null): HandoverFormValues => ({
  type: h?.type ?? DEFAULT_TYPE,
  date: h?.date ?? pragueToday(),
  participants: h?.participants ?? "",
  meters: h?.meterStates ?? [],
  notes: h?.notes ?? "",
});

function HandoverForm({
  projectId,
  editing,
  saving,
  setSaving,
  onCancel,
  onSaved,
}: {
  projectId: string;
  editing: Handover | null;
  saving: boolean;
  setSaving: (saving: boolean) => void;
  onCancel: () => void;
  onSaved: (saved: Handover) => void;
}) {
  const modal = useModal();
  const [baseline] = useState(() => valuesOf(editing));
  const [values, setValues] = useState<HandoverFormValues>(baseline);
  // The version the text on the screen is based on: the one the protocol had when it was opened, or the one loaded after a conflict.
  const [version, setVersion] = useState(editing?.updatedAt ?? null);
  const [problem, setProblem] = useState("");
  // The save was refused because the protocol changed meanwhile (or was signed): what was typed stays, and the person decides.
  const [conflict, setConflict] = useState<string | null>(null);
  // What the person had typed when they chose to load the other version: kept in view until the dialog is closed.
  const [mine, setMine] = useState<HandoverFormValues | null>(null);
  // The protocol was signed meanwhile: it cannot be saved over any more.
  const [locked, setLocked] = useState(false);
  const [loadingCurrent, setLoadingCurrent] = useState(false);

  const set = (patch: Partial<HandoverFormValues>) => setValues((current) => ({ ...current, ...patch }));
  const updateMeter = (idx: number, patch: Partial<Meter>) => set({ meters: values.meters.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });

  // Typed and not yet saved: a page that holds work says so, so that a lapsed session or a click on a link does not take it by surprise.
  // (The session dialog is a modal dialog of its own that stacks on top of this one, so the person can sign in again and carry on.)
  const dirty = JSON.stringify(values) !== JSON.stringify(baseline);
  useEffect(() => {
    setUnsavedWork(dirty);
    return () => setUnsavedWork(false);
  }, [dirty]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || locked) return;
    const wrong = handoverProblem(values);
    if (wrong) return setProblem(wrong);
    setSaving(true);
    setProblem("");
    const body = {
      type: values.type.trim(),
      date: values.date,
      participants: values.participants.trim(),
      meterStates: values.meters.filter((m) => m.medium.trim() || m.serialNumber.trim() || m.state.trim()),
      notes: values.notes.trim() || null,
    };
    try {
      const saved = editing
        ? await api<Handover>(`/api/handovers/${editing.id}`, { method: "PUT", body: json({ ...body, expectedUpdatedAt: version }) })
        : await api<Handover>(`/api/projects/${projectId}/handovers`, { method: "POST", body: json(body) });
      modal.close(() => onSaved(saved), { restoreFocus: true });
    } catch (err) {
      if (editing && err instanceof ApiError && err.status === 409) {
        // Somebody changed the protocol, or a party signed it: nothing of what was typed is thrown away or saved over it.
        setConflict(err.message);
        setLocked(err.code !== "STALE_VERSION");
      } else {
        setProblem(err instanceof Error ? err.message : "Předání se nepodařilo uložit");
      }
      setSaving(false);
    }
  };

  /** The person's choice: the form takes the stored protocol, and what they typed goes to a copy that stays in view. */
  const loadCurrent = async () => {
    if (!editing || loadingCurrent) return;
    setLoadingCurrent(true);
    setProblem("");
    try {
      const current = await api<Handover>(`/api/handovers/${editing.id}`);
      const signed = current.state !== "DRAFT";
      setMine(values);
      setValues(valuesOf(current));
      setVersion(current.updatedAt);
      setLocked(signed);
      setConflict(
        signed
          ? "Protokol mezitím podepsala jedna ze stran, nelze jej už měnit ani uložit. Vaše úpravy zůstávají níže, můžete si je zkopírovat."
          : "Načetli jsme aktuální verzi protokolu. Vaše úpravy zůstávají níže: můžete si z nich zkopírovat, co chcete zachovat, nebo je vrátit do formuláře a uložit (přepíšete tím změny druhé osoby).",
      );
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Aktuální verzi se nepodařilo načíst");
    } finally {
      setLoadingCurrent(false);
    }
  };

  const returnMine = () => {
    if (!mine) return;
    setValues(mine);
    setMine(null);
    setConflict(null);
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
      <Field id="handover-type" label="Typ předání" hint={limitHint(HANDOVER_LIMITS.type)}>
        <TextInput type="text" value={values.type} onChange={(e) => set({ type: e.target.value })} />
      </Field>
      <Field id="handover-date" label="Datum předání">
        <TextInput type="date" value={values.date} onChange={(e) => set({ date: e.target.value })} />
      </Field>
      <Field id="handover-participants" label="Účastníci předání" hint={limitHint(HANDOVER_LIMITS.participants)}>
        <TextInput type="text" value={values.participants} onChange={(e) => set({ participants: e.target.value })} />
      </Field>

      <div className="border-t border-line pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-ink">Měřidla a odběrná místa</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={values.meters.length >= HANDOVER_LIMITS.meters}
            onClick={() => set({ meters: [...values.meters, { medium: "", serialNumber: "", state: "" }] })}
          >
            Přidat měřidlo
          </Button>
        </div>
        {values.meters.map((m, idx) => (
          <div key={idx} className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <TextInput
              aria-label={`Médium měřidla ${idx + 1}`}
              placeholder="Médium (např. Voda, Elektřina VT)"
              value={m.medium}
              onChange={(e) => updateMeter(idx, { medium: e.target.value })}
            />
            <TextInput
              aria-label={`Výrobní číslo měřidla ${idx + 1}`}
              placeholder="Výrobní číslo"
              value={m.serialNumber}
              onChange={(e) => updateMeter(idx, { serialNumber: e.target.value })}
            />
            <TextInput aria-label={`Stav měřidla ${idx + 1}`} placeholder="Stav (např. 12450 kWh)" value={m.state} onChange={(e) => updateMeter(idx, { state: e.target.value })} />
            <Button variant="quiet" size="sm" onClick={() => set({ meters: values.meters.filter((_, i) => i !== idx) })}>
              Odebrat měřidlo {idx + 1}
            </Button>
          </div>
        ))}
      </div>

      <Field id="handover-notes" label="Poznámky / Závěry" hint={limitHint(HANDOVER_LIMITS.notes)}>
        <TextArea rows={3} value={values.notes} onChange={(e) => set({ notes: e.target.value })} />
      </Field>

      {editing && <p className="text-sm text-ink-muted">Protokol lze měnit, dokud ho nepodepíše jedna ze stran. Po prvním podpisu je uzamčen.</p>}
      {conflict && (
        <Banner tone="warning" role="alert">
          <p>{conflict}</p>
          {!mine && (
            <>
              <p className="mt-1 text-xs">Co jste napsali, zůstává ve formuláři, dokud nenačtete aktuální verzi; pak ho najdete pod formulářem.</p>
              <Button variant="secondary" size="sm" className="mt-2" disabled={loadingCurrent} onClick={() => void loadCurrent()}>
                Načíst aktuální verzi
              </Button>
            </>
          )}
        </Banner>
      )}
      {mine && (
        <section aria-labelledby="handover-mine-title" className="space-y-1 rounded-md border border-line bg-page p-3 text-sm">
          <h3 id="handover-mine-title" className="font-semibold text-ink">
            Vaše úpravy, které se neuložily
          </h3>
          <p>
            <span className="text-ink-muted">Typ:</span> {mine.type}
          </p>
          <p>
            <span className="text-ink-muted">Datum:</span> {mine.date}
          </p>
          <p>
            <span className="text-ink-muted">Účastníci:</span> {mine.participants}
          </p>
          {mine.meters.map((m, idx) => (
            <p key={idx}>
              <span className="text-ink-muted">Měřidlo {idx + 1}:</span> {m.medium} ({m.serialNumber}): {m.state}
            </p>
          ))}
          {mine.notes && <p className="whitespace-pre-wrap">{mine.notes}</p>}
          {!locked && (
            <Button variant="secondary" size="sm" className="mt-2" onClick={returnMine}>
              Vrátit moje úpravy do formuláře
            </Button>
          )}
        </section>
      )}
      {problem && <Banner tone="danger">{problem}</Banner>}
      <DialogButtons busy={saving} canSubmit={!locked} submit="Uložit předání" onCancel={onCancel} />
    </form>
  );
}

function SignDialog({
  handover,
  side,
  onCancel,
  onSigned,
  onStale,
}: {
  handover: Handover;
  side: HandoverSide;
  onCancel: () => void;
  onSigned: (signed: Handover) => void;
  onStale: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const party = side === "CONTRACTOR" ? "za zhotovitele" : "za stavebníka";
  return (
    <Modal
      title={`Podepsat předání ${party}`}
      description="Podepisujete právě tuto verzi protokolu. Po prvním podpisu jedné ze stran už protokol nelze změnit ani smazat. K podpisu zadejte své heslo."
      onCancel={onCancel}
      dismissible={!busy}
    >
      <SignForm handover={handover} side={side} busy={busy} setBusy={setBusy} onCancel={onCancel} onSigned={onSigned} onStale={onStale} />
    </Modal>
  );
}

function SignForm({
  handover,
  side,
  busy,
  setBusy,
  onCancel,
  onSigned,
  onStale,
}: {
  handover: Handover;
  side: HandoverSide;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onSigned: (signed: Handover) => void;
  onStale: (message: string) => void;
}) {
  const modal = useModal();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const sign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || password.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const signed = await api<Handover>(`/api/handovers/${handover.id}/sign`, {
        method: "POST",
        body: json({ side, password, expectedUpdatedAt: handover.updatedAt }),
      });
      modal.close(() => onSigned(signed));
    } catch (err) {
      if (err instanceof ApiError && (err.code === "STALE_VERSION" || err.status === 409 || err.status === 401)) {
        // Somebody changed the protocol or signed this side after it was loaded here (what the signer sees is not what would be
        // signed), or the session is over (its dialog is behind this one until this one is closed): the page says so and loads again.
        modal.close(() => onStale(err.message));
      } else {
        // A wrong password, a missing ČKAIT number, too many attempts: said in the dialog, which stays open.
        setError(err instanceof Error ? err.message : "Protokol se nepodařilo podepsat");
        setBusy(false);
      }
    }
  };

  return (
    <form onSubmit={(e) => void sign(e)} className="space-y-4">
      <div className="rounded-md border border-line bg-page p-3">
        <h3 className="mb-2 font-bold text-ink">{handover.type}</h3>
        <HandoverContent handover={handover} />
      </div>
      <Field id="handover-sign-password" label="Heslo" error={error || undefined}>
        <TextInput type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <DialogButtons busy={busy} canSubmit={password.length > 0} submit="Podepsat" onCancel={onCancel} />
    </form>
  );
}
