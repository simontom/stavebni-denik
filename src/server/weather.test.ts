import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  describeWeatherCode,
  fetchWeatherSnapshot,
  parseOpenMeteoDaily,
  unavailableWeather,
} from "./weather";

/**
 * The weather module is the evidentiary snapshot for a day, so the
 * parsing + fallback logic needs hard guarantees:
 *
 * - parseOpenMeteoDaily handles partial / missing data without throwing
 *   on the optional fields, only on a truly empty payload (so the caller
 *   falls back to an `unavailable` snapshot);
 * - unavailableWeather always produces the same shape (so the UI does
 *   not crash on missing keys);
 * - fetchWeatherSnapshot never throws — every error path returns an
 *   `unavailable` snapshot;
 * - GPS-less projects short-circuit to `unavailable` without a network
 *   call.
 */

describe("describeWeatherCode", () => {
  it("maps a known WMO code to its Czech label", () => {
    expect(describeWeatherCode(0)).toBe("Jasno");
    expect(describeWeatherCode(95)).toBe("Bouřka");
  });

  it("returns a sensible fallback for null / unknown codes", () => {
    expect(describeWeatherCode(null)).toBe("Počasí neuvedeno");
    expect(describeWeatherCode(9999)).toBe("Počasí");
  });
});

describe("parseOpenMeteoDaily", () => {
  it("reads the requested day even when the response has multiple days", () => {
    const snap = parseOpenMeteoDaily(
      {
        daily: {
          time: ["2026-06-15", "2026-06-16", "2026-06-17"],
          temperature_2m_min: [10.1, 11.2, 12.3],
          temperature_2m_max: [20.4, 21.5, 22.6],
          precipitation_sum: [0, 1.4, 0],
          wind_speed_10m_max: [12, 15, 18],
          weather_code: [1, 2, 3],
        },
      },
      "2026-06-16",
    );

    expect(snap.source).toBe("open-meteo");
    expect(snap.date).toBe("2026-06-16");
    expect(snap.tempMinC).toBe(11.2);
    expect(snap.tempMaxC).toBe(21.5);
    expect(snap.precipitationMm).toBe(1.4);
    expect(snap.windMaxKmh).toBe(15);
    expect(snap.weatherCode).toBe(2);
    expect(snap.summary).toBe("Polojasno, 11.2–21.5 °C");
  });

  it("falls back to index 0 when the requested day is missing", () => {
    const snap = parseOpenMeteoDaily(
      {
        daily: {
          time: ["2026-06-15"],
          temperature_2m_min: [5],
          temperature_2m_max: [7],
          precipitation_sum: [null],
          wind_speed_10m_max: [null],
          weather_code: [3],
        },
      },
      "2026-06-16",
    );
    expect(snap.tempMinC).toBe(5);
    expect(snap.tempMaxC).toBe(7);
    expect(snap.precipitationMm).toBeNull();
    expect(snap.windMaxKmh).toBeNull();
    expect(snap.summary).toBe("Zataženo, 5–7 °C");
  });

  it("handles null temperatures gracefully in the summary", () => {
    const snap = parseOpenMeteoDaily(
      {
        daily: {
          time: ["2026-06-16"],
          temperature_2m_min: [null],
          temperature_2m_max: [null],
          precipitation_sum: [0],
          wind_speed_10m_max: [0],
          weather_code: [null],
        },
      },
      "2026-06-16",
    );
    expect(snap.tempMinC).toBeNull();
    expect(snap.tempMaxC).toBeNull();
    expect(snap.summary).toBe("Počasí neuvedeno");
  });

  it("throws on an empty payload so the caller can mark it unavailable", () => {
    expect(() =>
      parseOpenMeteoDaily({ daily: { time: [] } }, "2026-06-16"),
    ).toThrow();
    expect(() => parseOpenMeteoDaily({}, "2026-06-16")).toThrow();
  });

  it("rounds raw values to one decimal place", () => {
    const snap = parseOpenMeteoDaily(
      {
        daily: {
          time: ["2026-06-16"],
          temperature_2m_min: [9.97],
          temperature_2m_max: [19.94],
          precipitation_sum: [2.456],
          wind_speed_10m_max: [33.339],
          weather_code: [0],
        },
      },
      "2026-06-16",
    );
    expect(snap.tempMinC).toBe(10);
    expect(snap.tempMaxC).toBe(19.9);
    expect(snap.precipitationMm).toBe(2.5);
    expect(snap.windMaxKmh).toBe(33.3);
  });
});

describe("unavailableWeather", () => {
  it("produces a consistent shape with nulls + an error message", () => {
    const snap = unavailableWeather("2026-06-16", "Vypršel časový limit (5 s).");
    expect(snap.source).toBe("unavailable");
    expect(snap.date).toBe("2026-06-16");
    expect(snap.tempMinC).toBeNull();
    expect(snap.tempMaxC).toBeNull();
    expect(snap.precipitationMm).toBeNull();
    expect(snap.windMaxKmh).toBeNull();
    expect(snap.weatherCode).toBeNull();
    expect(snap.error).toBe("Vypršel časový limit (5 s).");
  });
});

describe("fetchWeatherSnapshot", () => {
  beforeEach(() => {
    process.env.OPEN_METEO_BASE = "https://example.test/v1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPEN_METEO_BASE;
  });

  it("returns an unavailable snapshot when the project has no GPS", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const snap = await fetchWeatherSnapshot({
      lat: null,
      lon: null,
      date: "2026-06-16",
    });
    expect(snap.source).toBe("unavailable");
    expect(snap.error).toMatch(/GPS/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses a successful response into an open-meteo snapshot", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          daily: {
            time: ["2026-06-16"],
            temperature_2m_min: [11],
            temperature_2m_max: [22],
            precipitation_sum: [0.5],
            wind_speed_10m_max: [10],
            weather_code: [1],
          },
        }),
        { status: 200 },
      ),
    );

    const snap = await fetchWeatherSnapshot({
      lat: 50.0,
      lon: 14.4,
      date: "2026-06-16",
    });
    expect(snap.source).toBe("open-meteo");
    expect(snap.tempMinC).toBe(11);
    expect(snap.tempMaxC).toBe(22);
    expect(snap.weatherCode).toBe(1);
  });

  it("returns unavailable on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 503 }),
    );

    const snap = await fetchWeatherSnapshot({
      lat: 50.0,
      lon: 14.4,
      date: "2026-06-16",
    });
    expect(snap.source).toBe("unavailable");
    expect(snap.error).toMatch(/503/);
  });

  it("returns unavailable when fetch throws (timeout / network error)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("Aborted"), { name: "AbortError" }),
    );

    const snap = await fetchWeatherSnapshot({
      lat: 50.0,
      lon: 14.4,
      date: "2026-06-16",
    });
    expect(snap.source).toBe("unavailable");
    expect(snap.error).toMatch(/limit/i);
  });

  it("refuses to fetch when OPEN_METEO_BASE points off the allow-list (SSRF guard)", async () => {
    // Force production-mode validation; default NODE_ENV in tests
    // short-circuits the host check so test fixtures can use
    // example.test / localhost without false rejection.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPEN_METEO_BASE", "http://169.254.169.254/latest/meta-data");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const snap = await fetchWeatherSnapshot({
        lat: 50.0,
        lon: 14.4,
        date: "2026-06-16",
      });
      expect(snap.source).toBe("unavailable");
      expect(snap.error).toMatch(/nepovolen/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses an http:// (non-TLS) override in production mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPEN_METEO_BASE", "http://api.open-meteo.com/v1");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const snap = await fetchWeatherSnapshot({
        lat: 50.0,
        lon: 14.4,
        date: "2026-06-16",
      });
      expect(snap.source).toBe("unavailable");
      expect(snap.error).toMatch(/nepovolen/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
