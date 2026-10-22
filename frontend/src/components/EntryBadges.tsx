import { StatusBadge } from "./ui";

/**
 * One vocabulary for the state of an entry, on the list and in the head of the entry: a draft is "Rozpracováno", a signed entry
 * "Podepsáno", and a day nobody has written yet is "Nezapsáno". The state is a filled badge; a mark on the entry (a late entry, a
 * control day, the construction object, somebody having read it) is an outlined one. The meaning is in the words, never in the colour.
 *
 * **Exactly one element on the entry page says "Podepsáno"** (the E2E specs match it exactly): the state badge of the head. Nothing
 * else on that page may use the word as a whole text (the signature card says "Podepsal", "Podpis").
 */
export function EntryStateBadge({ state }: { state: "none" | "draft" | "signed" }) {
  if (state === "signed") return <StatusBadge tone="success">Podepsáno</StatusBadge>;
  if (state === "draft") return <StatusBadge tone="warning">Rozpracováno</StatusBadge>;
  return <StatusBadge tone="neutral">Nezapsáno</StatusBadge>;
}

/** An entry for a day before the previous working day (decision D10). */
export function LateEntryBadge() {
  return (
    <StatusBadge tone="warning" outlined>
      Pozdní zápis
    </StatusBadge>
  );
}

/** A day on which an inspection took place. */
export function ControlDayBadge() {
  return (
    <StatusBadge tone="info" outlined>
      Kontrolní den
    </StatusBadge>
  );
}
