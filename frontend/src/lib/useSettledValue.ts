import { useCallback, useEffect, useRef, useState } from "react";

/**
 * [value] as it is once it has stopped changing for [delayMs] (a typist's pause), and a function that settles it at once (the field
 * lost the focus). It is what an `aria-live` region is given, so a screen reader hears "Celkem: 12 pracovníků" once when the person has
 * done typing and not at every key. The first value is settled from the start: nothing is announced when the page opens.
 */
export function useSettledValue<T>(value: T, delayMs: number): [T, () => void] {
  const [settled, setSettled] = useState(value);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  const settleNow = useCallback(() => setSettled(latest.current), []);
  return [settled, settleNow];
}
