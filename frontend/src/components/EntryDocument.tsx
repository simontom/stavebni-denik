import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { formatPragueDateTime } from "../lib/dates";
import { emptyDetailsLine, signerLine, splitDetails, totalWorkers, workersOf } from "../lib/entryDocument";
import { Button, cn } from "./ui";

/** What the document needs of an entry, as the API sends it (`GET /api/projects/{id}/reports/{day}`). */
export interface DocumentEntry {
  workDescription?: string | null;
  /** The trades as a JSON text. */
  workersByTrade?: unknown;
  /** The weather as the words the signature covers; null when nothing is stated. */
  weatherText?: string | null;
  details?: Record<string, string> | null;
  isLateEntry?: boolean;
  lateEntryReason?: string | null;
}

const sectionTitle = "text-base font-semibold text-ink";

/**
 * A signed entry, and any entry seen by somebody who cannot write, as a document: headings and text, not disabled fields. What the
 * entry says is printed in full; the fields of the vyhláška that say nothing are named in one line ("Bez záznamu: …"), so a signed
 * entry is not a page of empty boxes. (While an entry is edited every field stays on the screen: they prompt for what the decree asks.)
 *
 * The control-day mark and the construction object are in the head of the page, not repeated here. A screen reader meets headings
 * (one per part), a definition list for the fields and a table for the trades.
 */
export function EntryDocument({ entry }: { entry: DocumentEntry }) {
  const workers = workersOf(entry.workersByTrade);
  const { filled, emptyLabels } = splitDetails(entry.details);
  const noDetails = emptyDetailsLine(emptyLabels);
  const description = entry.workDescription?.trim() ? entry.workDescription : null;
  const lateReason = entry.isLateEntry ? entry.lateEntryReason?.trim() : null;

  return (
    <div className="space-y-6">
      {lateReason && (
        <section aria-labelledby="entry-late-reason">
          <h2 id="entry-late-reason" className={sectionTitle}>
            Důvod pozdního zápisu
          </h2>
          <p className="mt-1 whitespace-pre-wrap text-ink">{lateReason}</p>
        </section>
      )}

      <section aria-labelledby="entry-work">
        <h2 id="entry-work" className={sectionTitle}>
          Popis prací
        </h2>
        {description ? <p className="mt-1 whitespace-pre-wrap text-ink">{description}</p> : <p className="mt-1 text-ink-muted">Bez záznamu.</p>}
      </section>

      <section aria-labelledby="entry-workers">
        <h2 id="entry-workers" className={sectionTitle}>
          Pracovníci podle profesí
        </h2>
        {workers.length === 0 ? (
          <p className="mt-1 text-ink-muted">Bez záznamu.</p>
        ) : (
          <>
            <table className="mt-2 w-full text-left text-sm max-sm:table-cards">
              <thead>
                <tr className="border-b border-line text-ink-muted">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Profese
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Počet
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Jména
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {workers.map((line, index) => (
                  <tr key={index}>
                    <td data-label="Profese" className="py-2 pr-4 align-top font-medium text-ink">
                      {line.trade}
                    </td>
                    <td data-label="Počet" className="py-2 pr-4 align-top text-ink tabular-nums">
                      {line.count}
                    </td>
                    <td data-label="Jména" className="py-2 align-top text-ink">
                      {line.names.length > 0 ? line.names.join("; ") : <span className="text-ink-muted">neuvedena</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-sm font-medium text-ink tabular-nums">Celkem pracovníků: {totalWorkers(workers)}</p>
          </>
        )}
      </section>

      <section aria-labelledby="entry-weather">
        <h2 id="entry-weather" className={sectionTitle}>
          Počasí
        </h2>
        <p className="mt-1 text-ink">{entry.weatherText?.trim() ? entry.weatherText : <span className="text-ink-muted">Neuvedeno.</span>}</p>
      </section>

      <section aria-labelledby="entry-details">
        <h2 id="entry-details" className={sectionTitle}>
          Další zápisy
        </h2>
        {filled.length > 0 && (
          <dl className="mt-2 space-y-4">
            {filled.map((field) => (
              <div key={field.key}>
                <dt className="text-sm font-medium text-ink-muted">{field.label}</dt>
                <dd className="mt-1 whitespace-pre-wrap text-ink">{field.text}</dd>
              </div>
            ))}
          </dl>
        )}
        {noDetails && <p className={cn("text-sm text-ink-muted", filled.length > 0 ? "mt-4" : "mt-1")}>{noDetails}</p>}
      </section>
    </div>
  );
}

/** What GET /api/reports/{id}/signature answers. */
export interface SignatureCheck {
  signed: boolean;
  signedByName?: string | null;
  signerCkaitNumber?: string | null;
  /** The signer's name and number are the ones stored when the entry was signed (format 3), not those the account has now. */
  signerFrozen?: boolean;
  /** What a format 3 signature needs and the entry lacks (`signerName`, `signerCkaitNumber`, `partASnapshot`). */
  missingFields?: string[];
  signatureHash?: string | null;
  /** The content hashed again equals the recorded hash; null when there is nothing to compare with. */
  contentMatches: boolean | null;
  photoFilesMatch: boolean | null;
}

/**
 * The one place that says an entry is signed, apart from the state badge of the head: who signed (with the ČKAIT number), when, the
 * number of the entry, the fingerprint of what was signed, and the button that checks it. A calm card with a lock, not an alarm: the
 * entry being locked is the normal end of its life, not a warning. Everything is shown at once; "Ověřit podpis" only verifies.
 *
 * It does not say "Podepsáno" as a whole text (the state badge does, and the E2E specs match it exactly): it says "Podepsal", "Podpis".
 */
export function SignatureCard({
  signerName,
  signerCkaitNumber,
  signerFrozen,
  signedAt,
  sequenceNumber,
  signatureHash,
  loading = false,
  loadFailed = false,
  onRetry,
  signerIncomplete = false,
  canCheck,
  check,
  onCheck,
  children,
}: {
  signerName?: string | null;
  signerCkaitNumber?: string | null;
  signerFrozen?: boolean;
  signedAt?: string | null;
  sequenceNumber?: number | null;
  signatureHash?: string | null;
  /** The entry has just been signed and what the server says of the signature has not arrived yet. */
  loading?: boolean;
  /** Reading it again failed: the card says so and offers [onRetry]. */
  loadFailed?: boolean;
  onRetry?: () => void;
  /** The signature lacks the name or the number of its signer: the card does not show half a signer as if it were whole. */
  signerIncomplete?: boolean;
  canCheck: boolean;
  check: SignatureCheck | null;
  onCheck: () => void;
  /** What a reader may do with a signed entry (acknowledge it). */
  children?: ReactNode;
}) {
  const signer = signerLine(signerName, signerCkaitNumber);
  return (
    <section aria-labelledby="entry-signature" className="rounded-lg border border-l-4 border-line border-l-success bg-surface p-4 shadow-sm sm:p-6">
      <div className="flex items-start gap-3">
        <Lock aria-hidden="true" className="mt-1 size-5 shrink-0 text-success-ink" />
        <div className="min-w-0 flex-1">
          <h2 id="entry-signature" className="text-lg font-semibold text-ink">
            Podpis záznamu
          </h2>
          <p className="mt-1 text-sm text-ink-muted">Záznam je podepsán a uzamčen. Opravy se vedou formou dodatků.</p>

          {loading ? (
            <p className="mt-4 text-sm text-ink-muted">Načítám údaje o podpisu…</p>
          ) : loadFailed ? (
            <div className="mt-4 space-y-2">
              <p className="text-sm text-ink">Údaje o podpisu se nepodařilo načíst.</p>
              <Button variant="secondary" size="sm" onClick={onRetry}>
                Zkusit znovu
              </Button>
            </div>
          ) : (
            <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
              <dt className="font-medium text-ink-muted">Podepsal</dt>
              <dd className="text-ink">
                {signer ?? "Jméno podepisujícího se nepodařilo zjistit"}
                {signer && signerFrozen === false && <span className="text-ink-muted"> (podle účtu, jak je dnes)</span>}
              </dd>
              <dt className="font-medium text-ink-muted">Čas podpisu</dt>
              <dd className="text-ink tabular-nums">{signedAt ? <time dateTime={signedAt}>{formatPragueDateTime(signedAt)}</time> : "neznámý"}</dd>
              {typeof sequenceNumber === "number" && (
                <>
                  <dt className="font-medium text-ink-muted">Číslo záznamu</dt>
                  <dd className="text-ink tabular-nums">{sequenceNumber}</dd>
                </>
              )}
              {signatureHash && (
                <>
                  <dt className="font-medium text-ink-muted">Otisk obsahu (SHA-256)</dt>
                  <dd className="font-mono text-xs break-all text-ink">{signatureHash}</dd>
                </>
              )}
            </dl>
          )}

          {/* Not an alarm and not a status of its own (the verification below is the one status of the page): a plain notice. */}
          {signerIncomplete && !loading && !loadFailed && (
            <p className="mt-3 rounded-md bg-neutral-soft p-3 text-sm text-neutral-ink">Údaje o podepisujícím jsou neúplné; ověřte podpis.</p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {canCheck && (
              <Button variant="secondary" size="sm" onClick={onCheck}>
                Ověřit podpis
              </Button>
            )}
            {children}
          </div>

          {check && (
            <div role="status" className={`mt-3 text-sm ${check.contentMatches === false || check.photoFilesMatch === false ? "text-danger-ink" : "text-success-ink"}`}>
              {check.signedByName
                ? `Podepsal ${check.signedByName}${check.signerCkaitNumber ? `, ČKAIT ${check.signerCkaitNumber}` : ""}${
                    check.signerFrozen ? " (jméno a číslo uložené při podpisu)" : " (podle účtu, jak je dnes)"
                  }. `
                : ""}
              {check.contentMatches === null
                ? "Záznam byl podepsán dříve, než se otisk začal ukládat: není s čím porovnat."
                : check.contentMatches
                  ? "Obsah odpovídá podpisu."
                  : "POZOR: obsah záznamu se po podpisu změnil."}{" "}
              {check.missingFields && check.missingFields.length > 0 ? "POZOR: u podpisu chybí údaje, které se při podpisu ukládají, záznam nelze ověřit. " : ""}
              {check.photoFilesMatch === false ? "POZOR: soubor fotografie se po podpisu změnil." : ""}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
