"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Camera, ChevronDown, ChevronUp, ExternalLink, X } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Dismissible „co a kdy fotit" checklist nad photo-uploaderem.
 *
 * Stavební deník v ČR (Vyhláška 499/2006, příloha 16) vyžaduje
 * dokumentaci klíčových konstrukčních fází *před zakrytím*. Pokud
 * je něco zazděné / zakopané / zaklopené, fotka je často **jediný
 * důkaz** stavu (případný spor s investorem / projektantem). Tahle
 * komponenta je rychlý reminder, **co fotit** během dne — vychází
 * z článku Buldo "Fotodokumentace stavby a nejčastější chyby
 * stavebníků" (odkaz dole).
 *
 * UX:
 *   - sbalený stav defaultně, persistovaný v `localStorage`,
 *   - dismiss = „Skrýt napořád" → druhý localStorage flag,
 *   - po dismiss komponenta nic nerenderuje (user může reset přes
 *     vymazání cookies / lokálního úložiště v prohlížeči, pro
 *     stavební deník to není kritická funkce).
 *
 * Hydratujeme přes `useSyncExternalStore`, ne přes
 * useEffect+setState — React 19 to vidí jako čistý externí store
 * (server vrací `null` snapshot, klient pak rovnou skutečnou
 * hodnotu z LS bez „flash" obsahu).
 */

const LS_KEY_DISMISSED = "photo-guidance-dismissed";
const LS_KEY_COLLAPSED = "photo-guidance-collapsed";

const BULDO_URL =
  "https://www.buldo.cz/fotodokumentace-stavby-a-nejcastejsi-chyby-stavebniku/";

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
// a key. Subscribe set is a Set so React's batched re-renders
// don't duplicate notifications.
const subscribers = new Set<() => void>();
function notify(): void {
  for (const fn of subscribers) fn();
}
function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  // Cross-tab updates: another tab dismisses → this tab reflects.
  const handler = (e: StorageEvent) => {
    if (e.key === LS_KEY_DISMISSED || e.key === LS_KEY_COLLAPSED) fn();
  };
  window.addEventListener("storage", handler);
  return () => {
    subscribers.delete(fn);
    window.removeEventListener("storage", handler);
  };
}

function getDismissed(): boolean {
  try {
    return localStorage.getItem(LS_KEY_DISMISSED) === "1";
  } catch {
    return false;
  }
}

function getCollapsed(): boolean {
  try {
    return localStorage.getItem(LS_KEY_COLLAPSED) !== "0";
  } catch {
    return true;
  }
}

function setLs(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage zablokovaný (incognito / restrictive policy) —
    // změna stavu nezůstane mezi reloady, ale UI se update-ne
    // přes notify() v rámci sezení.
  }
  notify();
}

export function PhotoGuidance() {
  const dismissed = useSyncExternalStore(
    subscribe,
    getDismissed,
    // Server snapshot: nic — komponenta se na serveru NEVYKRESLÍ,
    // protože je v "use client" hierarchii a renderuje se až po
    // hydrataci. Tady stačí stabilní hodnota.
    () => false,
  );
  const collapsed = useSyncExternalStore(
    subscribe,
    getCollapsed,
    () => true,
  );

  const toggle = useCallback(() => {
    setLs(LS_KEY_COLLAPSED, collapsed ? "0" : "1");
  }, [collapsed]);

  const dismiss = useCallback(() => {
    setLs(LS_KEY_DISMISSED, "1");
  }, []);

  if (dismissed) return null;

  return (
    <aside className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className="flex flex-1 items-center gap-2 text-left font-medium text-amber-900 hover:underline dark:text-amber-200"
        >
          <Camera className="size-4 shrink-0" aria-hidden />
          <span>Co stihnout vyfotit dnes</span>
          {collapsed ? (
            <ChevronDown className="size-4 shrink-0" aria-hidden />
          ) : (
            <ChevronUp className="size-4 shrink-0" aria-hidden />
          )}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={dismiss}
          className="-mr-1 -mt-1 h-7 px-2 text-amber-900 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900/40"
          aria-label="Skrýt napořád"
          title="Skrýt napořád"
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>

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
          <p className="pt-1 text-xs">
            Více tipů a častých chyb:{" "}
            <a
              href={BULDO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline"
            >
              článek Buldo
              <ExternalLink className="size-3" aria-hidden />
            </a>
            .
          </p>
        </div>
      )}
    </aside>
  );
}

