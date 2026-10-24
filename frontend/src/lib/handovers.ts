/**
 * Site handover protocols (předání a převzetí staveniště): what the server sends, which side of one a person signs, and what the
 * form checks before it asks. The server decides everything (the role is read again inside the transaction, the limits are checked
 * again); this module only decides what the page offers and says, so that a person is not shown a button that ends in a refusal.
 */
import type { BadgeTone } from "../components/ui";

export type HandoverSide = "CONTRACTOR" | "CLIENT";
export type HandoverState = "DRAFT" | "SIGNED_BY_CONTRACTOR" | "SIGNED_BY_CLIENT" | "COMPLETE";

export interface Meter {
  medium: string;
  serialNumber: string;
  state: string;
}

/** One party's signature: who signed, in which role, with which ČKAIT number (the contractor), when, and the two hashes. */
export interface HandoverSignature {
  side: HandoverSide;
  signedById: string;
  signerName: string;
  signerRole: string;
  signerCkaitNumber?: string | null;
  signedAt: string;
  /** The SHA-256 of the content both parties signed. */
  contentHash: string;
  signatureHash: string;
}

export interface Handover {
  id: string;
  type: string;
  date: string;
  participants: string;
  meterStates?: Meter[] | null;
  notes?: string | null;
  createdById?: string | null;
  /** The version of the content: sent back as `expectedUpdatedAt` when the protocol is changed or signed. */
  updatedAt: string;
  state: HandoverState;
  contractorSignature?: HandoverSignature | null;
  clientSignature?: HandoverSignature | null;
}

/** The side a person with [role] in the project signs for: a manager for the contractor, the builder (stavebník) or the supervision for the client. */
export function sideOfRole(role?: string | null): HandoverSide | null {
  if (role === "BOSS") return "CONTRACTOR";
  if (role === "INVESTOR" || role === "INSPECTOR") return "CLIENT";
  return null;
}

/**
 * The side [userId] may sign now, or null: the person's side while it is still unsigned, and never when the same person already
 * signed the other one (their role changed in between; the server refuses that too).
 */
export function signableSide(role: string | null | undefined, userId: string | null | undefined, handover: Handover): HandoverSide | null {
  const side = sideOfRole(role);
  if (!side) return null;
  const signed = side === "CONTRACTOR" ? handover.contractorSignature : handover.clientSignature;
  if (signed) return null;
  const other = side === "CONTRACTOR" ? handover.clientSignature : handover.contractorSignature;
  if (other && userId && other.signedById === userId) return null;
  return side;
}

/** The manager of the project and the worker who made the protocol may change it, and only until one of the parties has signed. */
export function canEditHandover(role: string | null | undefined, userId: string | null | undefined, handover: Handover): boolean {
  if (handover.state !== "DRAFT") return false;
  if (role === "BOSS") return true;
  return role === "WORKER" && Boolean(userId) && handover.createdById === userId;
}

/** The roles that may make a protocol (the server decides): the manager and the workers. */
export const canCreateHandover = (role?: string | null): boolean => role === "BOSS" || role === "WORKER";

export const SIDE_NAMES: Record<HandoverSide, { who: string; sign: string }> = {
  CONTRACTOR: { who: "Zhotovitel", sign: "Podepsat za zhotovitele" },
  CLIENT: { who: "Stavebník", sign: "Podepsat za stavebníka" },
};

const STATES: Record<HandoverState, { text: string; tone: BadgeTone }> = {
  DRAFT: { text: "Rozpracováno, čeká na podpisy", tone: "neutral" },
  SIGNED_BY_CONTRACTOR: { text: "Podepsal zhotovitel, čeká na stavebníka", tone: "warning" },
  SIGNED_BY_CLIENT: { text: "Podepsal stavebník, čeká na zhotovitele", tone: "warning" },
  COMPLETE: { text: "Podepsáno oběma stranami", tone: "success" },
};

export const stateLabel = (state: HandoverState): { text: string; tone: BadgeTone } => STATES[state];

/** The longest text the server accepts (SiteHandoverService.MAX_*): the form shows it and checks it, it never cuts what is typed. */
export const HANDOVER_LIMITS = { type: 200, participants: 2000, notes: 5000, meters: 50, meterField: 100 } as const;

/** Characters as a person counts them: an emoji is one, as on the server. */
const length = (text: string): number => [...text].length;

const spaced = (n: number): string => n.toLocaleString("cs-CZ").replace(/ /g, " ");

export interface HandoverFormValues {
  type: string;
  date: string;
  participants: string;
  notes: string;
  meters: Meter[];
}

/** What is wrong with the form, in words, or null: the same limits as the server (which has the last word). */
export function handoverProblem(values: HandoverFormValues): string | null {
  if (values.type.trim() === "") return "Typ předání je povinný";
  if (values.date.trim() === "") return "Datum předání je povinné";
  if (length(values.type.trim()) > HANDOVER_LIMITS.type) return `Typ předání může mít nejvýše ${spaced(HANDOVER_LIMITS.type)} znaků`;
  if (length(values.participants.trim()) > HANDOVER_LIMITS.participants) return `Účastníci předání mohou mít nejvýše ${spaced(HANDOVER_LIMITS.participants)} znaků`;
  if (length(values.notes.trim()) > HANDOVER_LIMITS.notes) return `Poznámky mohou mít nejvýše ${spaced(HANDOVER_LIMITS.notes)} znaků`;
  if (values.meters.length > HANDOVER_LIMITS.meters) return `Protokol může mít nejvýše ${HANDOVER_LIMITS.meters} měřidel`;
  const long = values.meters.some((m) => [m.medium, m.serialNumber, m.state].some((t) => length(t.trim()) > HANDOVER_LIMITS.meterField));
  if (long) return `Médium, výrobní číslo a stav měřidla mohou mít nejvýše ${HANDOVER_LIMITS.meterField} znaků`;
  return null;
}
