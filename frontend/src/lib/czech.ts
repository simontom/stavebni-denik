/** The form of a Czech noun that goes with [n]: one (1 pracovník), few (2 to 4 pracovníci) or many (0 and 5 or more pracovníků). */
export function czechPlural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return many;
}
