import { formatDate, formatDateTime } from "@/lib/dates";

export interface PrintProjectData {
  name: string;
  address: string;
  cadastralArea: string;
  parcelNumbers: string;
  permitNumber?: string | null;
  contractNumber?: string | null;
  contractDate?: Date | string | null;
  designDocVersion?: string | null;
  designDocDate?: Date | string | null;
  builder: string;
  contractor: string;
  siteManagerName: string;
  tdsName?: string | null;
  bozpName?: string | null;
  designerName?: string | null;
}

interface PrintCoverPageProps {
  project: PrintProjectData;
  dateRangeLabel: string;
  daysCount: number;
}

export function PrintCoverPage({ project, dateRangeLabel, daysCount }: PrintCoverPageProps) {
  return (
    <>
      <h1>Stavební deník</h1>
      <div className="project-card">
        <h2>{project.name}</h2>
        <dl>
          <dt>Místo stavby</dt>
          <dd>{project.address}</dd>
          <dt>Katastrální území</dt>
          <dd>{project.cadastralArea}</dd>
          <dt>Parcelní čísla</dt>
          <dd>{project.parcelNumbers}</dd>
          {project.permitNumber && (
            <>
              <dt>Č. stavebního povolení</dt>
              <dd>{project.permitNumber}</dd>
            </>
          )}
          {project.contractNumber && (
            <>
              <dt>Číslo smlouvy</dt>
              <dd>{project.contractNumber}</dd>
            </>
          )}
          {project.contractDate && (
            <>
              <dt>Datum smlouvy</dt>
              <dd>{formatDate(project.contractDate)}</dd>
            </>
          )}
          {project.designDocVersion && (
            <>
              <dt>Verze PD</dt>
              <dd>{project.designDocVersion}</dd>
            </>
          )}
          {project.designDocDate && (
            <>
              <dt>Datum PD</dt>
              <dd>{formatDate(project.designDocDate)}</dd>
            </>
          )}
          <dt>Stavebník</dt>
          <dd>{project.builder}</dd>
          <dt>Zhotovitel</dt>
          <dd>{project.contractor}</dd>
          <dt>Stavbyvedoucí</dt>
          <dd>{project.siteManagerName}</dd>
          {project.tdsName && (
            <>
              <dt>Technický dozor stavebníka</dt>
              <dd>{project.tdsName}</dd>
            </>
          )}
          {project.bozpName && (
            <>
              <dt>Koordinátor BOZP</dt>
              <dd>{project.bozpName}</dd>
            </>
          )}
          {project.designerName && (
            <>
              <dt>Projektant</dt>
              <dd>{project.designerName}</dd>
            </>
          )}
          <dt>Období exportu</dt>
          <dd>{dateRangeLabel}</dd>
          <dt>Exportováno</dt>
          <dd>{formatDateTime(new Date())}</dd>
          <dt>Počet záznamů</dt>
          <dd>{daysCount}</dd>
        </dl>
      </div>
    </>
  );
}
