"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Camera, ChevronDown, ChevronUp } from "lucide-react";

/**
 * Always-visible „co a kdy fotit" checklist nad photo-uploaderem.
 *
 * Stavební deník v ČR (Vyhláška 499/2006, příloha 16) vyžaduje
 * dokumentaci klíčových konstrukčních fází *před zakrytím*. Pokud
 * je něco zazděné / zakopané / zaklopené, fotka je často **jediný
 * důkaz** stavu (případný spor s investorem / projektantem). Tahle
 * komponenta je rychlý reminder, **co fotit** během dne — vychází
 * z článku Buldo "Fotodokumentace stavby a nejčastější chyby
 * stavebníků".
 *
 * UX:
 *   - Sbalený stav defaultně (jen klikatelná hlavička s ikonou).
 *     Uživatel může rozbalit kliknutím; preference se ukládá
 *     v `localStorage`.
 *   - Žádné permanentní skrytí — banner je doménově důležitý
 *     compliance reminder, nemá smysl ho úplně vypnout.
 *
 * Hydratujeme přes `useSyncExternalStore`, ne přes
 * useEffect+setState — React 19 to vidí jako čistý externí store
 * (server vrací `true` snapshot = collapsed; klient se může lišit
 * jen v jediné konstantě, ne ve struktuře DOM).
 */

const LS_KEY_COLLAPSED = "photo-guidance-collapsed";

interface ChecklistGroup {
  title: string;
  items: string[];
}

const CHECKLIST: ChecklistGroup[] = [
  {
    title: "Základy a zemní práce",
    items: [
      "Výkop pro základy (rozměry, hloubka, podloží).",
      "Vyztužení základové desky před zalitím betonem.",
      "Hydroizolace spodní stavby před zaházením.",
      "Uložené inženýrské sítě (voda, kanalizace, plyn) před záhozem.",
    ],
  },
  {
    title: "Hrubá stavba",
    items: [
      "Zdivo s vyznačením otvorů (před omítkou).",
      "Stropní konstrukce — výztuž před betonáží.",
      "Bednění a věnce.",
      "Komíny a šachty.",
    ],
  },
  {
    title: "Instalace (před zakrytím!)",
    items: [
      "Elektroinstalace — drážky, krabice, vodiče před omítkou.",
      "Rozvody vody a topení — před zaklopením podlahy.",
      "Plynová instalace + tlaková zkouška.",
      "Vzduchotechnika — rozvody v podhledech.",
    ],
  },
  {
    title: "Izolace a střecha",
    items: [
      "Tepelná izolace (typ, tloušťka, napojení) před zakrytím.",
      "Parozábrana / hydroizolace střechy.",
      "Krov, podbití, klempířské prvky.",
    ],
  },
  {
    title: "Dokončovací práce",
    items: [
      "Stav místností před předáním.",
      "Detaily napojení (okno-zdivo, dveře-podlaha).",
      "Případné vady a nedodělky (datovaná dokumentace).",
    ],
  },
];

// Module-level pub/sub — `localStorage` doesn't fire `storage` events
// in the SAME tab, so we wake subscribers ourselves whenever we set
// the key. Cross-tab updates piggyback on the native `storage` event.
const subscribers = new Set<() => void>();
function notify(): void {
  for (const fn of subscribers) fn();
}
function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  const handler = (e: StorageEvent) => {
    if (e.key === LS_KEY_COLLAPSED) fn();
  };
  window.addEventListener("storage", handler);
  return () => {
    subscribers.delete(fn);
    window.removeEventListener("storage", handler);
  };
}

function getCollapsed(): boolean {
  try {
    return localStorage.getItem(LS_KEY_COLLAPSED) !== "0";
  } catch {
    return true;
  }
}

function setLs(value: string): void {
  try {
    localStorage.setItem(LS_KEY_COLLAPSED, value);
  } catch {
    // localStorage zablokovaný (incognito / restrictive policy) —
    // preference se neuloží mezi reloady, ale UI se update-ne
    // v rámci sezení přes notify().
  }
  notify();
}

export function PhotoGuidance() {
  const collapsed = useSyncExternalStore(
    subscribe,
    getCollapsed,
    () => true,
  );

  const toggle = useCallback(() => {
    setLs(collapsed ? "0" : "1");
  }, [collapsed]);

  return (
    <aside className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 text-left font-medium text-amber-900 hover:underline dark:text-amber-200"
      >
        <Camera className="size-4 shrink-0" aria-hidden />
        <span className="flex-1">Co stihnout vyfotit dnes</span>
        {collapsed ? (
          <ChevronDown className="size-4 shrink-0" aria-hidden />
        ) : (
          <ChevronUp className="size-4 shrink-0" aria-hidden />
        )}
      </button>

      {!collapsed && (
        <div className="mt-3 space-y-3 text-amber-950 dark:text-amber-100">
          <p className="text-xs text-amber-900/80 dark:text-amber-200/80">
            Co je <strong>zakryté</strong>, už nikdo nevyfotí. Vyhláška
            499/2006 (příloha 16) vyžaduje doložit klíčové fáze stavby
            — fotka před zakrytím je často jediný důkaz.
          </p>
          {CHECKLIST.map((group) => (
            <div key={group.title}>
              <p className="font-medium">{group.title}</p>
              <ul className="ml-4 mt-1 list-disc space-y-0.5 text-xs">
                {group.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

