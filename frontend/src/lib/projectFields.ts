/**
 * What is entered about a project: the identification of the diary (vyhláška 131/2024 Sb., příloha 12, part A). One component
 * for the page that creates a project and the page that changes it, so the two cannot drift apart.
 */
export interface ProjectFieldValues {
  name: string;
  address: string;
  cadastralArea: string;
  parcelNumbers: string;
  builder: string;
  contractor: string;
  permitNumber: string;
  permitDate: string;
  designerName: string;
  tdsName: string;
  bozpName: string;
  contractNumber: string;
  contractDate: string;
  designDocVersion: string;
  designDocDate: string;
  subcontractors: string;
  supportingDocuments: string;
}

type Key = keyof ProjectFieldValues;

export interface FieldSpec {
  key: Key;
  label: string;
  type?: "text" | "date" | "textarea";
  required?: boolean;
  placeholder?: string;
  hint?: string;
}

export const LONGEST_NAME = 200;
export const LONGEST_LIST = 5000;

/** The fields every project has, always asked. */
export const CORE: FieldSpec[] = [
  { key: "name", label: "Název stavby", required: true },
  { key: "address", label: "Místo stavby / Adresa", required: true },
  { key: "cadastralArea", label: "Katastrální území", required: true },
  { key: "parcelNumbers", label: "Parcelní čísla", required: true },
  { key: "builder", label: "Stavebník (Objednatel)", required: true },
  { key: "contractor", label: "Zhotovitel", required: true },
];

export const SECTIONS: { title: string; fields: FieldSpec[] }[] = [
  {
    title: "Povolení a osoby řídící stavbu",
    fields: [
      { key: "permitNumber", label: "Číslo povolení", placeholder: "např. SZ/2026/123" },
      { key: "permitDate", label: "Datum povolení", type: "date" },
      { key: "designerName", label: "Projektant", placeholder: "Jméno nebo firma" },
      { key: "tdsName", label: "Technický dozor stavebníka", placeholder: "Jméno" },
      { key: "bozpName", label: "Koordinátor BOZP", placeholder: "Jméno" },
    ],
  },
  {
    title: "Legislativní náležitosti (Smlouva a dokumentace)",
    fields: [
      { key: "contractNumber", label: "Číslo smlouvy", placeholder: "např. SML-123" },
      { key: "contractDate", label: "Datum smlouvy", type: "date" },
      { key: "designDocVersion", label: "Verze projektové dokumentace", placeholder: "např. v1.2" },
      { key: "designDocDate", label: "Datum projektové dokumentace", type: "date" },
    ],
  },
  {
    title: "Poddodavatelé a podklady",
    fields: [
      {
        key: "subcontractors",
        label: "Poddodavatelé",
        type: "textarea",
        placeholder: "Jedna firma na řádek (název, IČO, sídlo)",
      },
      {
        key: "supportingDocuments",
        label: "Podklady stavby",
        type: "textarea",
        placeholder: "Jeden doklad na řádek: smlouvy, povolení, souhlasy, rozhodnutí, protokoly",
      },
    ],
  },
];

export const emptyProjectFields = (): ProjectFieldValues => ({
  name: "",
  address: "",
  cadastralArea: "",
  parcelNumbers: "",
  builder: "",
  contractor: "",
  permitNumber: "",
  permitDate: "",
  designerName: "",
  tdsName: "",
  bozpName: "",
  contractNumber: "",
  contractDate: "",
  designDocVersion: "",
  designDocDate: "",
  subcontractors: "",
  supportingDocuments: "",
});

/** A date as the server sends it (an instant) cut to the day an `<input type="date">` takes. */
const dayOf = (value: unknown): string => (typeof value === "string" ? value.split("T")[0] : "");
const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** The form values of a project as the API returns it. */
export const projectFieldsOf = (project: Record<string, unknown>): ProjectFieldValues => ({
  name: textOf(project.name),
  address: textOf(project.address),
  cadastralArea: textOf(project.cadastralArea),
  parcelNumbers: textOf(project.parcelNumbers),
  builder: textOf(project.builder),
  contractor: textOf(project.contractor),
  permitNumber: textOf(project.permitNumber),
  permitDate: dayOf(project.permitDate),
  designerName: textOf(project.designerName),
  tdsName: textOf(project.tdsName),
  bozpName: textOf(project.bozpName),
  contractNumber: textOf(project.contractNumber),
  contractDate: dayOf(project.contractDate),
  designDocVersion: textOf(project.designDocVersion),
  designDocDate: dayOf(project.designDocDate),
  subcontractors: textOf(project.subcontractors),
  supportingDocuments: textOf(project.supportingDocuments),
});

/** The request body for the fields: what is empty is null (the server stores nothing for it). */
export const projectPayload = (values: ProjectFieldValues) => ({
  name: values.name,
  address: values.address,
  cadastralArea: values.cadastralArea,
  parcelNumbers: values.parcelNumbers,
  builder: values.builder,
  contractor: values.contractor,
  permitNumber: values.permitNumber.trim() || null,
  permitDate: values.permitDate || null,
  designerName: values.designerName.trim() || null,
  tdsName: values.tdsName.trim() || null,
  bozpName: values.bozpName.trim() || null,
  contractNumber: values.contractNumber.trim() || null,
  contractDate: values.contractDate || null,
  designDocVersion: values.designDocVersion.trim() || null,
  designDocDate: values.designDocDate || null,
  subcontractors: values.subcontractors.trim() || null,
  supportingDocuments: values.supportingDocuments.trim() || null,
});

/** The first problem a form can see before sending, or null. The server checks everything again. */
export const projectFieldsProblem = (values: ProjectFieldValues): string | null => {
  for (const spec of [...CORE, ...SECTIONS.flatMap((s) => s.fields)]) {
    if (spec.required && values[spec.key].trim() === "") return `${spec.label}: vyplňte údaj`;
    if (spec.type === "textarea" && values[spec.key].length > LONGEST_LIST) return `${spec.label}: nejvýše ${LONGEST_LIST} znaků`;
  }
  return null;
};
