import { formatDate, formatDateTime } from "@/lib/dates";
import type { ProjectExportDay } from "@/server/services/reports";

interface PrintDailyRecordProps {
  day: ProjectExportDay;
  pageBreakBefore?: boolean;
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

export function PrintDailyRecord({ day, pageBreakBefore = false }: PrintDailyRecordProps) {
  const total = workersTotal(day.workers);

  return (
    <section className={pageBreakBefore ? "day day-break" : "day"}>
      <header className="day-header">
        <h2>
          Záznam č. {day.sequenceNumber} ze dne {formatDate(day.date)}
        </h2>
        {day.isControlDay && (
          <span className="official" style={{ marginLeft: "8px", verticalAlign: "middle" }}>
            Kontrolní den
          </span>
        )}
        <div className="day-meta">
          Zapsal: {day.authorName}
          {day.signedByName && day.signedAt && (
            <>
              {" "}
              · Podepsal: {day.signedByName} ({formatDateTime(day.signedAt)})
            </>
          )}
          {day.acknowledgedByName && <> · Potvrdil investor: {day.acknowledgedByName}</>}
        </div>
      </header>

      <div className="weather">
        <strong>Počasí:</strong> {day.weather.summary}
        {day.weather.tempMinC !== null && day.weather.tempMaxC !== null && (
          <>
            {" "}
            · {day.weather.tempMinC}–{day.weather.tempMaxC} °C
          </>
        )}
        {day.weather.precipitationMm !== null && <> · srážky {day.weather.precipitationMm} mm</>}
        {day.weather.windMaxKmh !== null && <> · vítr {day.weather.windMaxKmh} km/h</>}
      </div>

      <div className="workers">
        <strong>Pracovníci ({total}):</strong>{" "}
        {day.workers.length === 0
          ? "neuvedeno"
          : day.workers.map((w) => `${w.trade} ${w.count}×`).join(", ")}
      </div>

      <Field label="Stavební objekt" value={day.constructionObj} />
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
