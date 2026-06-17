import { notFound } from "next/navigation";

import { formatDate, formatDateTime, pragueDayStart } from "@/lib/dates";
import { requireUser } from "@/server/rbac";
import { getProjectForUser } from "@/server/services/projects";
import {
  getProjectExportForUser,
  type ProjectExportDay,
} from "@/server/services/reports";

/**
 * Print-friendly server-rendered view of a project's daily diary, used
 * by the Playwright PDF wrapper. Never linked in the regular UI — the
 * user-facing flow is the "Stáhnout PDF" button on /projects/[id]
 * which calls /api/projects/[id]/pdf; that route then loads this page
 * in headless Chromium.
 *
 * The root layout already provides html/body/font so we render only
 * the print content + an inline <style> that overrides the screen
 * stylesheet inside @page bounds.
 */

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readDate(value: string | string[] | undefined): Date | null {
  const v = typeof value === "string" ? value : null;
  if (!v || !DATE_RE.test(v)) return null;
  return pragueDayStart(v);
}

function workersTotal(workers: ProjectExportDay["workers"]): number {
  return workers.reduce((sum, w) => sum + w.count, 0);
}

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value || value.trim().length === 0) return null;
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="field-value">{value}</div>
    </div>
  );
}

function DaySection({ day, index }: { day: ProjectExportDay; index: number }) {
  const total = workersTotal(day.workers);
  return (
    <section className={index === 0 ? "day" : "day day-break"}>
      <header className="day-header">
        <h2>{formatDate(day.date)}</h2>
        <div className="day-meta">
          Zapsal: {day.authorName}
          {day.signedByName && day.signedAt && (
            <> · Podepsal: {day.signedByName} ({formatDateTime(day.signedAt)})</>
          )}
        </div>
      </header>

      <div className="weather">
        <strong>Počasí:</strong> {day.weather.summary}
        {day.weather.tempMinC !== null && day.weather.tempMaxC !== null && (
          <> · {day.weather.tempMinC}–{day.weather.tempMaxC} °C</>
        )}
        {day.weather.precipitationMm !== null && (
          <> · srážky {day.weather.precipitationMm} mm</>
        )}
        {day.weather.windMaxKmh !== null && (
          <> · vítr {day.weather.windMaxKmh} km/h</>
        )}
      </div>

      <div className="workers">
        <strong>Pracovníci ({total}):</strong>{" "}
        {day.workers.length === 0
          ? "neuvedeno"
          : day.workers.map((w) => `${w.trade} ${w.count}×`).join(", ")}
      </div>

      <Field label="Popis prací" value={day.workDescription} />
      <Field label="Dodávky materiálu" value={day.materialsIn} />
      <Field label="Mechanizace" value={day.machinery} />
      <Field label="Zkoušky a měření" value={day.testsAndChecks} />
      <Field label="BOZP" value={day.safetyNotes} />
      <Field label="Závady a nedodělky" value={day.defects} />
      <Field label="Ostatní" value={day.otherNotes} />

      {day.remarks.length > 0 && (
        <div className="block">
          <div className="block-title">Připomínky</div>
          <ul className="remarks">
            {day.remarks.map((r) => (
              <li key={r.id}>
                <strong>{r.authorName}</strong>{" "}
                {r.isOfficial && <span className="official">[oficiální]</span>}{" "}
                <span className="dim">({formatDateTime(r.createdAt)})</span>
                <div className="multiline">{r.text}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {day.materials.length > 0 && (
        <div className="block">
          <div className="block-title">Materiál na další dny</div>
          <ul className="materials">
            {day.materials.map((m) => (
              <li key={m.id}>
                {m.resolved ? "✓ " : "• "}
                {m.text}
                {m.neededBy && <span className="dim"> (do {formatDate(m.neededBy)})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {day.addenda.length > 0 && (
        <div className="block">
          <div className="block-title">Dodatky</div>
          <ul className="addenda">
            {day.addenda.map((a) => (
              <li key={a.id}>
                <strong>{a.authorName}</strong>{" "}
                <span className="dim">({formatDateTime(a.createdAt)})</span>
                <div className="multiline">{a.text}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {day.photos.length > 0 && (
        <div className="block">
          <div className="block-title">Fotografie ({day.photos.length})</div>
          <div className="photos">
            {day.photos.map((p, i) => (
              /* Headless Chromium fetches /api/photos/... with the
                 cookies we forwarded to the browser context. */
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                key={p.id}
                src={`/api/photos/${p.id}?variant=thumb`}
                alt={`Fotografie ${i + 1}`}
                className="photo"
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export default async function PrintProjectPage({
  params,
  searchParams,
}: PageProps) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;

  const project = await getProjectForUser(id, user);
  if (!project) notFound();

  const from = readDate(sp.from);
  const to = readDate(sp.to);
  const exportData = await getProjectExportForUser({
    projectId: id,
    from,
    to,
    user,
  });
  if (!exportData) notFound();

  const days = exportData.days;
  const dateRangeLabel =
    from && to
      ? `${formatDate(from)} – ${formatDate(to)}`
      : from
        ? `od ${formatDate(from)}`
        : to
          ? `do ${formatDate(to)}`
          : "celé období";

  const css = [
    "@page { size: A4; margin: 0; }",
    "html, body { background: #fff !important; }",
    "body { font-family: 'Liberation Sans', sans-serif; color: #222; font-size: 11pt; line-height: 1.35; margin: 0; padding: 0; }",
    "#print-root { padding: 10mm 12mm; max-width: none; }",
    "#print-root h1 { font-size: 18pt; margin: 0 0 8pt; }",
    "#print-root h2 { font-size: 14pt; margin: 0 0 4pt; }",
    "#print-root .project-card { border: 1pt solid #ccc; padding: 8pt; margin-bottom: 16pt; }",
    "#print-root .project-card dl { display: grid; grid-template-columns: 38mm 1fr; gap: 2pt 8pt; margin: 4pt 0 0; }",
    "#print-root .project-card dt { color: #555; }",
    "#print-root .project-card dd { margin: 0; }",
    "#print-root .day { padding-top: 6pt; }",
    "#print-root .day-break { page-break-before: always; padding-top: 0; }",
    "#print-root .day-header h2 { display: inline-block; margin-right: 8pt; }",
    "#print-root .day-meta { display: inline; color: #555; font-size: 9pt; }",
    "#print-root .weather, #print-root .workers { margin: 4pt 0; }",
    "#print-root .field { margin: 4pt 0; }",
    "#print-root .field-label { font-weight: 600; font-size: 10pt; color: #333; }",
    "#print-root .field-value { white-space: pre-wrap; }",
    "#print-root .block { margin: 6pt 0; }",
    "#print-root .block-title { font-weight: 600; font-size: 10pt; margin-bottom: 2pt; }",
    "#print-root .multiline { white-space: pre-wrap; margin-left: 8pt; }",
    "#print-root .remarks, #print-root .materials, #print-root .addenda { margin: 0; padding-left: 14pt; }",
    "#print-root .remarks li, #print-root .materials li, #print-root .addenda li { margin-bottom: 4pt; page-break-inside: avoid; }",
    "#print-root .dim { color: #777; font-size: 9pt; }",
    "#print-root .official { background: #fee; padding: 0 4pt; border-radius: 2pt; font-size: 9pt; }",
    "#print-root .photos { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4pt; }",
    "#print-root .photo { width: 100%; height: 35mm; object-fit: cover; border: 0.5pt solid #ddd; page-break-inside: avoid; }",
    "#print-root .empty { color: #666; font-style: italic; }",
  ].join("\n");

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div id="print-root">
        <h1>Stavební deník</h1>
        <div className="project-card">
          <h2>{project.project.name}</h2>
          <dl>
            <dt>Místo stavby</dt>
            <dd>{project.project.address}</dd>
            <dt>Katastrální území</dt>
            <dd>{project.project.cadastralArea}</dd>
            <dt>Parcelní čísla</dt>
            <dd>{project.project.parcelNumbers}</dd>
            {project.project.permitNumber && (
              <>
                <dt>Č. stavebního povolení</dt>
                <dd>{project.project.permitNumber}</dd>
              </>
            )}
            <dt>Stavebník</dt>
            <dd>{project.project.builder}</dd>
            <dt>Zhotovitel</dt>
            <dd>{project.project.contractor}</dd>
            <dt>Stavbyvedoucí</dt>
            <dd>{project.project.siteManagerName}</dd>
            {project.project.tdsName && (
              <>
                <dt>Technický dozor stavebníka</dt>
                <dd>{project.project.tdsName}</dd>
              </>
            )}
            {project.project.bozpName && (
              <>
                <dt>Koordinátor BOZP</dt>
                <dd>{project.project.bozpName}</dd>
              </>
            )}
            {project.project.designerName && (
              <>
                <dt>Projektant</dt>
                <dd>{project.project.designerName}</dd>
              </>
            )}
            <dt>Období exportu</dt>
            <dd>{dateRangeLabel}</dd>
            <dt>Exportováno</dt>
            <dd>{formatDateTime(new Date())}</dd>
            <dt>Počet záznamů</dt>
            <dd>{days.length}</dd>
          </dl>
        </div>

        {days.length === 0 ? (
          <p className="empty">V daném období nejsou žádné denní záznamy.</p>
        ) : (
          days.map((day, i) => <DaySection key={day.id} day={day} index={i} />)
        )}
      </div>
    </>
  );
}
