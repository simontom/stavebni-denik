/**
 * Pure constants/types pro visits — bezpečné importovat z client komponent
 * (nemá `server-only`, nemá DB). Service `src/server/services/visits.ts`
 * tyto symboly re-exportuje pro convenience.
 */

/**
 * Předdefinované role návštěvníka dle vyhlášky 499/2006 § 6.
 * Pořadí: nejčastější první, výjimečné poslední.
 */
export const VISITOR_ROLES = [
  "TDS",
  "Autorský dozor",
  "Projektant",
  "Investor",
  "Stavební úřad",
  "Koordinátor BOZP",
  "Inspektorát práce",
  "Jiné",
] as const;

export type VisitorRole = (typeof VISITOR_ROLES)[number];
