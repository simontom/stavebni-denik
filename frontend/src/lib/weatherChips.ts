/**
 * The quick choices for the weather of the day (backlog B5): chips under the field "Popis" that put a condition into its text. The text
 * stays what it was: plain words, stored and signed as typed (`WeatherData.describe()` and the signed weather text are not touched), and
 * free text stays possible. A chip **changes the text as little as it can**: it appends ", word" at the end, or takes out that one word with
 * one comma next to it; the other words, the separators, the spaces and the case are left exactly as they were typed.
 */

/** The conditions the form suggests. The field's own list of suggestions (`<datalist>`) is the same. */
export const WEATHER_CONDITIONS = ["jasno", "polojasno", "oblačno", "zataženo", "mlha", "přeháňky", "déšť", "bouřka", "sněžení", "mráz", "silný vítr"];

/** The longest weather text the server takes (`WeatherData`). */
export const MAX_WEATHER_CHARS = 200;

const same = (a: string, b: string) => a.toLocaleLowerCase("cs") === b.toLocaleLowerCase("cs");

/** The words of a text that lists them with commas: where each one is (without the spaces around it) and what it says. Empty places are no word. */
function wordsOf(text: string): { start: number; end: number; word: string; commaAfter: number | null; commaBefore: number | null; nextStart: number | null }[] {
  const parts: { start: number; end: number; word: string; segStart: number; segEnd: number }[] = [];
  let segStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === ",") {
      const segment = text.slice(segStart, i);
      const word = segment.trim();
      const lead = segment.length - segment.trimStart().length;
      parts.push({ start: segStart + lead, end: segStart + lead + word.length, word, segStart, segEnd: i });
      segStart = i + 1;
    }
  }
  return parts.flatMap((p, index) =>
    p.word === ""
      ? []
      : [
          {
            start: p.start,
            end: p.end,
            word: p.word,
            commaAfter: p.segEnd < text.length ? p.segEnd : null,
            commaBefore: p.segStart > 0 ? p.segStart - 1 : null,
            // where what follows the comma after this word begins (its spaces skipped), so that the word and its comma go together
            nextStart: index + 1 < parts.length ? parts[index + 1].start : null,
          },
        ],
  );
}

/** The text lists [condition] as one of its words (whatever the case or the spacing); `přeháňky` is not `déšť`, and `silný vítr` is not `vítr`. */
export const hasCondition = (text: string, condition: string): boolean => wordsOf(text).some((w) => same(w.word, condition));

/** [text] with [condition] appended after a comma, or the first such word taken out (one comma goes with it); the rest as it was typed. */
function toggled(text: string, condition: string): string {
  const found = wordsOf(text).find((w) => same(w.word, condition));
  if (found) {
    const cut = (from: number, to: number) => text.slice(0, from) + text.slice(to);
    // a comma follows: the word, its spaces and that comma, and the spaces after it, go; otherwise a comma before it goes with the word
    const result =
      found.commaAfter !== null && found.nextStart !== null
        ? cut(found.start, found.nextStart)
        : found.commaBefore !== null
          ? cut(found.commaBefore, found.end)
          : cut(found.start, found.end);
    return result.trim() === "" ? "" : result;
  }
  const kept = text.trimEnd();
  if (kept === "") return condition;
  return kept.endsWith(",") ? `${kept} ${condition}` : `${kept}, ${condition}`;
}

/** A word can be taken out of any text, and added when the text does not go over the limit with it. */
export const conditionFits = (text: string, condition: string): boolean => hasCondition(text, condition) || toggled(text, condition).length <= MAX_WEATHER_CHARS;

/** [text] after a tap on the chip of [condition]; a text that would go over the limit is left as it was (`conditionFits` says so). */
export function toggleCondition(text: string, condition: string): string {
  const next = toggled(text, condition);
  return hasCondition(text, condition) || next.length <= MAX_WEATHER_CHARS ? next : text;
}
