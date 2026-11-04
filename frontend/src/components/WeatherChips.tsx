import { useState } from "react";
import { buttonClasses } from "./ui";
import { MAX_WEATHER_CHARS, WEATHER_CONDITIONS, conditionFits, hasCondition, toggleCondition } from "../lib/weatherChips";

/**
 * Quick choices for the weather of the day (backlog B5), under the field "Popis": one tap puts a condition into the text above (appended
 * after a comma), a second takes it out, and the rest of what the person typed is left as it was (`lib/weatherChips.ts`). A chip is a real
 * button with `aria-pressed` (Space and Enter press it, Tab goes from one to the next); every one is a thumb high. The text stays plain text:
 * what is stored and signed is the text of the field. A word that would take the text past 200 characters is not added, and the person is told.
 */
export function WeatherChips({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  // The text the last refused tap was about: the message is for that text only, and goes with the next change of it.
  const [refusedFor, setRefusedFor] = useState<string | null>(null);
  const refused = refusedFor === value;
  return (
    <>
      <div role="group" aria-label="Rychlý výběr počasí" className="mt-2 flex flex-wrap gap-2">
        {WEATHER_CONDITIONS.map((condition) => {
          const pressed = hasCondition(value, condition);
          return (
            <button
              key={condition}
              type="button"
              aria-pressed={pressed}
              onClick={() => {
                if (!conditionFits(value, condition)) return setRefusedFor(value);
                onChange(toggleCondition(value, condition));
              }}
              className={buttonClasses({
                variant: "secondary",
                size: "sm",
                className: "rounded-full aria-pressed:border-primary aria-pressed:bg-primary-soft aria-pressed:font-bold aria-pressed:text-primary-ink",
              })}
            >
              {pressed && <span aria-hidden="true">✓</span>}
              {condition}
            </button>
          );
        })}
      </div>
      {/* Always in the page, so that what appears in it is announced */}
      <p role="status" className="text-sm font-medium text-danger-ink [&:not(:empty)]:mt-1">
        {refused ? `Nejvýše ${MAX_WEATHER_CHARS} znaků: do popisu se už nic nevejde.` : ""}
      </p>
    </>
  );
}
