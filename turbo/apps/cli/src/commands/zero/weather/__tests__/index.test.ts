import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import chalk from "chalk";
import { mkdtempSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HttpResponse, http } from "msw";

import { server } from "../../../../mocks/server";
import { zeroWeatherCommand } from "../index";

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "zero-weather-home-"));
const WEATHER_ATTRIBUTION = "Source: Includes weather data from Google";
const AIR_QUALITY_ATTRIBUTION = "Source: Includes air quality data from Google";

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => {
      return TEST_HOME;
    },
  };
});

describe("zero weather command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(async () => {
    await fs.rm(path.join(TEST_HOME, ".vm0"), { recursive: true, force: true });
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
  });

  afterEach(async () => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
    await fs.rm(path.join(TEST_HOME, ".vm0"), { recursive: true, force: true });
  });

  it("posts current-condition requests and prints zero-credit metadata", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/weather/current",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            operation: "current",
            provider: "google-weather",
            attribution: WEATHER_ATTRIBUTION,
            creditsCharged: 0,
            billingCategory: "current",
            billingQuantity: 1,
            result: { temperature: { degrees: 28, unit: "CELSIUS" } },
          });
        },
      ),
    );

    await zeroWeatherCommand.parseAsync([
      "node",
      "cli",
      "current",
      "--lat",
      "39.9042",
      "--lng",
      "116.4074",
      "--language",
      "zh-CN",
    ]);

    expect(requestBody).toEqual({
      lat: 39.9042,
      lng: 116.4074,
      units: "metric",
      languageCode: "zh-CN",
    });
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("✓ Current weather retrieved");
    expect(output).toContain("Provider: google-weather");
    expect(output).toContain(WEATHER_ATTRIBUTION);
    expect(output).toContain("Credits charged: 0");
  });

  it("passes hourly forecast range and pagination without aggregating pages", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/weather/forecast/hourly",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            operation: "forecast.hourly",
            provider: "google-weather",
            attribution: WEATHER_ATTRIBUTION,
            creditsCharged: 0,
            billingCategory: "forecast.hourly",
            billingQuantity: 1,
            result: {
              forecastHours: [],
              nextPageToken: "next-hourly-page",
            },
          });
        },
      ),
    );

    await zeroWeatherCommand.parseAsync([
      "node",
      "cli",
      "forecast",
      "hourly",
      "--lat",
      "37.7749",
      "--lng",
      "-122.4194",
      "--units",
      "imperial",
      "--hours",
      "72",
      "--page-size",
      "12",
      "--page-token",
      "hourly-page",
      "--json",
    ]);

    expect(requestBody).toEqual({
      lat: 37.7749,
      lng: -122.4194,
      units: "imperial",
      pageSize: 12,
      pageToken: "hourly-page",
      hours: 72,
    });
    expect(mockConsoleLog).toHaveBeenCalledWith(
      JSON.stringify({
        operation: "forecast.hourly",
        provider: "google-weather",
        attribution: WEATHER_ATTRIBUTION,
        creditsCharged: 0,
        billingCategory: "forecast.hourly",
        billingQuantity: 1,
        result: {
          forecastHours: [],
          nextPageToken: "next-hourly-page",
        },
      }),
    );
  });

  it("posts compact current air quality requests", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/weather/air-quality/current",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            operation: "air-quality.current",
            provider: "google-air-quality",
            attribution: AIR_QUALITY_ATTRIBUTION,
            creditsCharged: 0,
            billingCategory: "current",
            billingQuantity: 1,
            result: {
              indexes: [{ code: "uaqi", aqi: 42 }],
              pollutants: [{ code: "pm25", concentration: { value: 18.2 } }],
            },
          });
        },
      ),
    );

    await zeroWeatherCommand.parseAsync([
      "node",
      "cli",
      "air-quality",
      "current",
      "--lat",
      "39.9042",
      "--lng",
      "116.4074",
      "--language",
      "zh-CN",
    ]);

    expect(requestBody).toEqual({
      lat: 39.9042,
      lng: 116.4074,
      languageCode: "zh-CN",
    });
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("✓ Current air quality retrieved");
    expect(output).toContain("Provider: google-air-quality");
    expect(output).toContain(AIR_QUALITY_ATTRIBUTION);
    expect(output).toContain("Credits charged: 0");
  });

  it("posts daily forecast options to the daily endpoint", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/weather/forecast/daily",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            operation: "forecast.daily",
            provider: "google-weather",
            attribution: WEATHER_ATTRIBUTION,
            creditsCharged: 0,
            billingCategory: "forecast.daily",
            billingQuantity: 1,
            result: { forecastDays: [] },
          });
        },
      ),
    );

    await zeroWeatherCommand.parseAsync([
      "node",
      "cli",
      "forecast",
      "daily",
      "--lat",
      "51.5072",
      "--lng",
      "-0.1276",
      "--days",
      "10",
      "--page-size",
      "5",
      "--json",
    ]);

    expect(requestBody).toEqual({
      lat: 51.5072,
      lng: -0.1276,
      units: "metric",
      pageSize: 5,
      days: 10,
    });
  });

  it("posts recent hourly history options to the history endpoint", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/weather/history/hourly",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            operation: "history.hourly",
            provider: "google-weather",
            attribution: WEATHER_ATTRIBUTION,
            creditsCharged: 0,
            billingCategory: "history.hourly",
            billingQuantity: 1,
            result: { historyHours: [] },
          });
        },
      ),
    );

    await zeroWeatherCommand.parseAsync([
      "node",
      "cli",
      "history",
      "hourly",
      "--lat",
      "35.6762",
      "--lng",
      "139.6503",
      "--hours",
      "24",
      "--page-token",
      "history-page",
      "--json",
    ]);

    expect(requestBody).toEqual({
      lat: 35.6762,
      lng: 139.6503,
      units: "metric",
      pageToken: "history-page",
      hours: 24,
    });
  });
});
