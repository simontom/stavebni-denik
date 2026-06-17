import "server-only";

import { env } from "@/lib/env";

/**
 * Open-Meteo weather snapshot for a construction-diary day.
 *
 * The weather is part of the *evidentiary* content of a daily report
 * (it documents the conditions work was carried out in), so once a
 * report is created the snapshot is frozen in a JSONB column and never
 * re-fetched. When the API is unreachable we still create the report
 * with an `unavailable` snapshot and let the author fill the numbers in
 * by hand (`source: "manual"`, `manuallyEntered: true`).
 *
 * The network call lives in `fetchWeatherSnapshot`; the response→snapshot
 * mapping is the pure, dependency-free `parseOpenMeteoDaily` so it can be
 * unit-tested without hitting the network.
 */

export type WeatherSource = "open-meteo" | "manual" | "unavailable";

export interface WeatherSnapshot {
  source: WeatherSource;
  /** ISO timestamp the snapshot was produced. */
  fetchedAt: string;
  /** The Prague calendar day the snapshot describes (YYYY-MM-DD). */
  date: string;
  tempMinC: number | null;
  tempMaxC: number | null;
  precipitationMm: number | null;
  windMaxKmh: number | null;
  /** WMO weather interpretation code (https://open-meteo.com). */
  weatherCode: number | null;
  /** Human-readable Czech summary, e.g. "Polojasno, 4–17 °C". */
  summary: string;
  /** Present only when `source: "unavailable"`. */
  error?: string;
  /** True when a human edited the numbers after an unavailable fetch. */
  manuallyEntered?: boolean;
}

/** Network timeout for the Open-Meteo call (ms). */
const WEATHER_TIMEOUT_MS = 5000;

/**
 * Map a WMO weather interpretation code to a short Czech label.
 * Unknown codes fall back to a generic phrase.
 */
export function describeWeatherCode(code: number | null): string {
  if (code === null) return "Počasí neuvedeno";
  const table: Record<number, string> = {
    0: "Jasno",
    1: "Převážně jasno",
    2: "Polojasno",
    3: "Zataženo",
    45: "Mlha",
    48: "Námrazová mlha",
    51: "Slabé mrholení",
    53: "Mrholení",
    55: "Silné mrholení",
    56: "Mrznoucí mrholení",
    57: "Silné mrznoucí mrholení",
    61: "Slabý déšť",
    63: "Déšť",
    65: "Silný déšť",
    66: "Mrznoucí déšť",
    67: "Silný mrznoucí déšť",
    71: "Slabé sněžení",
    73: "Sněžení",
    75: "Silné sněžení",
    77: "Sněhová zrna",
    80: "Slabé přeháňky",
    81: "Přeháňky",
    82: "Prudké přeháňky",
    85: "Sněhové přeháňky",
    86: "Silné sněhové přeháňky",
    95: "Bouřka",
    96: "Bouřka s kroupami",
    99: "Silná bouřka s kroupami",
  };
  return table[code] ?? "Počasí";
}

/** Round to one decimal place, tolerating null/undefined. */
function round1(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }
  return Math.round(value * 10) / 10;
}

/** Build the Czech one-line summary from the mapped values. */
function buildSummary(
  code: number | null,
  tempMinC: number | null,
  tempMaxC: number | null,
): string {
  const label = describeWeatherCode(code);
  if (tempMinC === null && tempMaxC === null) return label;
  if (tempMinC !== null && tempMaxC !== null) {
    return `${label}, ${tempMinC}–${tempMaxC} °C`;
  }
  return `${label}, ${tempMaxC ?? tempMinC} °C`;
}

/**
 * Shape of the Open-Meteo `daily` block we request. Everything is
 * optional/loosely typed because the API may omit fields for dates
 * outside its coverage window.
 */
interface OpenMeteoDailyResponse {
  daily?: {
    time?: string[];
    temperature_2m_max?: Array<number | null>;
    temperature_2m_min?: Array<number | null>;
    precipitation_sum?: Array<number | null>;
    wind_speed_10m_max?: Array<number | null>;
    weather_code?: Array<number | null>;
  };
}

/**
 * Pure mapping of an Open-Meteo daily response into a snapshot. We
 * request exactly one day (`start_date == end_date == date`), so we read
 * index 0. Throws when the day is missing from the payload so the caller
 * can fall back to an `unavailable` snapshot.
 */
export function parseOpenMeteoDaily(
  json: OpenMeteoDailyResponse,
  date: string,
): WeatherSnapshot {
  const d = json.daily;
  if (!d || !Array.isArray(d.time) || d.time.length === 0) {
    throw new Error("Open-Meteo: prázdná odpověď (žádná data pro den).");
  }
  // Prefer the row matching the requested date; otherwise take the first.
  const i = Math.max(0, d.time.indexOf(date));

  const tempMaxC = round1(d.temperature_2m_max?.[i] ?? null);
  const tempMinC = round1(d.temperature_2m_min?.[i] ?? null);
  const precipitationMm = round1(d.precipitation_sum?.[i] ?? null);
  const windMaxKmh = round1(d.wind_speed_10m_max?.[i] ?? null);
  const weatherCode = d.weather_code?.[i] ?? null;

  return {
    source: "open-meteo",
    fetchedAt: new Date().toISOString(),
    date,
    tempMinC,
    tempMaxC,
    precipitationMm,
    windMaxKmh,
    weatherCode,
    summary: buildSummary(weatherCode, tempMinC, tempMaxC),
  };
}

/** Snapshot used when the API could not be reached / returned no data. */
export function unavailableWeather(date: string, error: string): WeatherSnapshot {
  return {
    source: "unavailable",
    fetchedAt: new Date().toISOString(),
    date,
    tempMinC: null,
    tempMaxC: null,
    precipitationMm: null,
    windMaxKmh: null,
    weatherCode: null,
    summary: "Počasí se nepodařilo načíst — doplňte ručně.",
    error,
  };
}

/**
 * Fetch a one-day weather snapshot from Open-Meteo for the given GPS
 * point and Prague calendar day. Never throws — on timeout, network
 * error, or empty payload it returns an `unavailable` snapshot so the
 * report can still be created (the author may fill the numbers in).
 *
 * When the project has no GPS coordinates we skip the call entirely.
 */
export async function fetchWeatherSnapshot(opts: {
  lat: number | null;
  lon: number | null;
  date: string;
}): Promise<WeatherSnapshot> {
  const { lat, lon, date } = opts;
  if (lat === null || lon === null) {
    return unavailableWeather(date, "Zakázka nemá vyplněné GPS souřadnice.");
  }

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily:
      "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code",
    timezone: "Europe/Prague",
    start_date: date,
    end_date: date,
  });
  const url = `${env.openMeteoBase}/forecast?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return unavailableWeather(date, `Open-Meteo HTTP ${res.status}.`);
    }
    const json = (await res.json()) as OpenMeteoDailyResponse;
    return parseOpenMeteoDaily(json, date);
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? "Vypršel časový limit (5 s)."
        : err instanceof Error
          ? err.message
          : "Neznámá chyba.";
    return unavailableWeather(date, reason);
  } finally {
    clearTimeout(timer);
  }
}
