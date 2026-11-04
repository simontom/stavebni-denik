/**
 * The quick choices for the weather of the day (backlog B5): chips under the field "Popis" that put a condition into its text. The text
 * stays what it was: plain words, stored and signed as typed (`WeatherData.describe()` and the signed weather text are not touched), and
 * free text stays possible. A chip adds its word after a comma (so "zataženo, déšť" is two taps) or takes it out again, and never touches
 * the words the person typed themselves.
 */

/** The conditions the form suggests. The field's own list of suggestions (`<datalist>`) is the same. */
export const WEATHER_CONDITIONS = ["jasno", "polojasno", "oblačno", "zataženo", "mlha", "přeháňky", "déšť", "bouřka", "sněžení", "mráz", "silný vítr"];

/** The longest weather text the server takes (`WeatherData`). */
export const MAX_WEATHER_CHARS = 200;

/** The words of a text that lists them with commas, trimmed. */
const words = (text: string): string[] =>
  text
    .split(",")
    .map((w) => w.trim())
    .filter((w) => w !== "");

const same = (a: string, b: string) => a.toLocaleLowerCase("cs") === b.toLocaleLowerCase("cs");

/** The text lists [condition] as one of its words (whatever the case or the spacing); `přeháňky` is not `déšť`, and `silný vítr` is not `vítr`. */
export const hasCondition = (text: string, condition: string): boolean => words(text).some((w) => same(w, condition));

/** [text] with [condition] added after a comma, or taken out when it is there; text that would go over the limit is left as it was. */
export function toggleCondition(text: string, condition: string): string {
  const list = words(text);
  if (list.some((w) => same(w, condition))) return list.filter((w) => !same(w, condition)).join(", ");
  const next = [...list, condition].join(", ");
  return next.length > MAX_WEATHER_CHARS ? text : next;
}
