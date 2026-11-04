import { buttonClasses } from "./ui";
import { WEATHER_CONDITIONS, hasCondition, toggleCondition } from "../lib/weatherChips";

/**
 * Quick choices for the weather of the day (backlog B5), under the field "Popis": one tap puts a condition into its text, a second takes it
 * out, and the words the person typed themselves are never touched. A chip is a real button with `aria-pressed` (Space and Enter press it,
 * Tab goes from one to the next); every one is a thumb high. The text stays plain text: what is stored and signed is the text of the field.
 */
export function WeatherChips({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div role="group" aria-label="Rychlý výběr počasí" className="mt-2 flex flex-wrap gap-2">
      {WEATHER_CONDITIONS.map((condition) => {
        const pressed = hasCondition(value, condition);
        return (
          <button
            key={condition}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(toggleCondition(value, condition))}
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
  );
}
