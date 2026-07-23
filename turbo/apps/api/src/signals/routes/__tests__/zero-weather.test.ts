import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import {
  ZERO_AIR_QUALITY_ATTRIBUTION,
  ZERO_WEATHER_ATTRIBUTION,
  zeroWeatherContract,
  type ZeroAirQualityResponse,
  type ZeroWeatherConditionsResponse,
} from "@vm0/api-contracts/contracts/zero-weather";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  seedOrgMetadata,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const GOOGLE_WEATHER_CURRENT_URL =
  "https://weather.googleapis.com/v1/currentConditions:lookup";
const GOOGLE_WEATHER_FORECAST_HOURLY_URL =
  "https://weather.googleapis.com/v1/forecast/hours:lookup";
const GOOGLE_WEATHER_FORECAST_DAILY_URL =
  "https://weather.googleapis.com/v1/forecast/days:lookup";
const GOOGLE_WEATHER_HISTORY_HOURLY_URL =
  "https://weather.googleapis.com/v1/history/hours:lookup";
const GOOGLE_AIR_QUALITY_CURRENT_URL =
  "https://airquality.googleapis.com/v1/currentConditions:lookup";

function authenticate(actor: ApiTestUser): { readonly authorization: string } {
  createZeroRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroWeatherContract);
}

function configureProvider(): void {
  mockEnv("ZERO_WEATHER_GOOGLE_WEATHER_TOKEN", "test-google-weather-key");
}

async function prepareFreeWeatherActor(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Zero Weather test actor must belong to an organization");
  }
  await createBddApi(context).bootstrapOnboarding(actor, {
    displayName: "Zero Weather Test",
  });
  await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits: 0 });
  await seedUsagePricingRows([
    {
      kind: "weather",
      provider: "google-weather",
      category: "current",
      unitPrice: 0,
      unitSize: 1,
    },
    {
      kind: "weather",
      provider: "google-weather",
      category: "forecast.hourly",
      unitPrice: 0,
      unitSize: 1,
    },
    {
      kind: "weather",
      provider: "google-weather",
      category: "forecast.daily",
      unitPrice: 0,
      unitSize: 1,
    },
    {
      kind: "weather",
      provider: "google-weather",
      category: "history.hourly",
      unitPrice: 0,
      unitSize: 1,
    },
    {
      kind: "weather",
      provider: "google-air-quality",
      category: "current",
      unitPrice: 0,
      unitSize: 1,
    },
  ]);
}

function expectFreeWeatherResponse(
  body: ZeroWeatherConditionsResponse,
  operation: ZeroWeatherConditionsResponse["operation"],
): void {
  expect(body).toMatchObject({
    operation,
    provider: "google-weather",
    attribution: ZERO_WEATHER_ATTRIBUTION,
    creditsCharged: 0,
    billingCategory: operation,
    billingQuantity: 1,
  });
}

function expectFreeAirQualityResponse(body: ZeroAirQualityResponse): void {
  expect(body).toMatchObject({
    operation: "air-quality.current",
    provider: "google-air-quality",
    attribution: ZERO_AIR_QUALITY_ATTRIBUTION,
    creditsCharged: 0,
    billingCategory: "current",
    billingQuantity: 1,
  });
}

describe("zero weather route", () => {
  it("rejects requests when the feature switch is disabled", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Zero Weather test actor must belong to an organization");
    }
    await updateFeatureSwitchesForUser(
      context,
      {
        userId: actor.userId,
        orgId: actor.orgId,
        ...(actor.orgRole ? { orgRole: actor.orgRole } : {}),
      },
      { [FeatureSwitchKey.ZeroWeather]: false },
    );
    configureProvider();
    let providerRequests = 0;
    server.use(
      http.get(GOOGLE_WEATHER_CURRENT_URL, () => {
        providerRequests += 1;
        return HttpResponse.json({});
      }),
    );

    const response = await accept(
      client().current({
        headers: authenticate(actor),
        body: { lat: 39.9042, lng: 116.4074, units: "metric" },
      }),
      [403],
    );

    expect(response.body.error.message).toBe("Zero Weather is not enabled");
    expect(providerRequests).toBe(0);
  });

  it("returns not configured before calling Google Weather", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    mockEnv("ZERO_WEATHER_GOOGLE_WEATHER_TOKEN", undefined);
    server.use(
      http.get(GOOGLE_WEATHER_CURRENT_URL, () => {
        providerRequests += 1;
        return HttpResponse.json({});
      }),
    );

    const response = await accept(
      client().current({
        headers: authenticate(actor),
        body: { lat: 39.9042, lng: 116.4074, units: "metric" },
      }),
      [503],
    );

    expect(response.body.error.code).toBe("NOT_CONFIGURED");
    expect(providerRequests).toBe(0);
  });

  it("records current conditions at zero credits for an empty balance", async () => {
    const actor = createBddApi(context).user();
    await prepareFreeWeatherActor(actor);
    configureProvider();
    let providerUrl: URL | undefined;
    server.use(
      http.get(GOOGLE_WEATHER_CURRENT_URL, ({ request }) => {
        providerUrl = new URL(request.url);
        return HttpResponse.json({
          weatherCondition: { description: { text: "晴" } },
          temperature: { degrees: 28, unit: "CELSIUS" },
        });
      }),
    );

    const response = await accept(
      client().current({
        headers: authenticate(actor),
        body: {
          lat: 39.9042,
          lng: 116.4074,
          units: "metric",
          languageCode: "zh-CN",
        },
      }),
      [200],
    );

    expectFreeWeatherResponse(response.body, "current");
    expect(response.body.result).toMatchObject({
      weatherCondition: { description: { text: "晴" } },
    });
    expect(providerUrl?.searchParams.get("key")).toBe(
      "test-google-weather-key",
    );
    expect(providerUrl?.searchParams.get("location.latitude")).toBe("39.9042");
    expect(providerUrl?.searchParams.get("location.longitude")).toBe(
      "116.4074",
    );
    expect(providerUrl?.searchParams.get("unitsSystem")).toBe("METRIC");
    expect(providerUrl?.searchParams.get("languageCode")).toBe("zh-CN");
  });

  it("forwards one hourly forecast page to Google Weather", async () => {
    const actor = createBddApi(context).user();
    await prepareFreeWeatherActor(actor);
    configureProvider();
    let providerUrl: URL | undefined;
    server.use(
      http.get(GOOGLE_WEATHER_FORECAST_HOURLY_URL, ({ request }) => {
        providerUrl = new URL(request.url);
        return HttpResponse.json({
          forecastHours: [],
          nextPageToken: "next-hourly-page",
        });
      }),
    );

    const response = await accept(
      client().forecastHourly({
        headers: authenticate(actor),
        body: {
          lat: 37.7749,
          lng: -122.4194,
          units: "imperial",
          hours: 72,
          pageSize: 12,
          pageToken: "hourly-page",
        },
      }),
      [200],
    );

    expectFreeWeatherResponse(response.body, "forecast.hourly");
    expect(providerUrl?.searchParams.get("unitsSystem")).toBe("IMPERIAL");
    expect(providerUrl?.searchParams.get("hours")).toBe("72");
    expect(providerUrl?.searchParams.get("pageSize")).toBe("12");
    expect(providerUrl?.searchParams.get("pageToken")).toBe("hourly-page");
  });

  it("forwards one daily forecast page to Google Weather", async () => {
    const actor = createBddApi(context).user();
    await prepareFreeWeatherActor(actor);
    configureProvider();
    let providerUrl: URL | undefined;
    server.use(
      http.get(GOOGLE_WEATHER_FORECAST_DAILY_URL, ({ request }) => {
        providerUrl = new URL(request.url);
        return HttpResponse.json({ forecastDays: [] });
      }),
    );

    const response = await accept(
      client().forecastDaily({
        headers: authenticate(actor),
        body: {
          lat: 51.5072,
          lng: -0.1276,
          units: "metric",
          days: 10,
          pageSize: 5,
          pageToken: "daily-page",
        },
      }),
      [200],
    );

    expectFreeWeatherResponse(response.body, "forecast.daily");
    expect(providerUrl?.searchParams.get("days")).toBe("10");
    expect(providerUrl?.searchParams.get("pageSize")).toBe("5");
    expect(providerUrl?.searchParams.get("pageToken")).toBe("daily-page");
  });

  it("forwards one hourly history page to Google Weather", async () => {
    const actor = createBddApi(context).user();
    await prepareFreeWeatherActor(actor);
    configureProvider();
    let providerUrl: URL | undefined;
    server.use(
      http.get(GOOGLE_WEATHER_HISTORY_HOURLY_URL, ({ request }) => {
        providerUrl = new URL(request.url);
        return HttpResponse.json({ historyHours: [] });
      }),
    );

    const response = await accept(
      client().historyHourly({
        headers: authenticate(actor),
        body: {
          lat: 35.6762,
          lng: 139.6503,
          units: "metric",
          hours: 24,
          pageSize: 24,
          pageToken: "history-page",
        },
      }),
      [200],
    );

    expectFreeWeatherResponse(response.body, "history.hourly");
    expect(providerUrl?.searchParams.get("hours")).toBe("24");
    expect(providerUrl?.searchParams.get("pageSize")).toBe("24");
    expect(providerUrl?.searchParams.get("pageToken")).toBe("history-page");
  });

  it("returns compact current air quality at zero credits", async () => {
    const actor = createBddApi(context).user();
    await prepareFreeWeatherActor(actor);
    configureProvider();
    let providerUrl: URL | undefined;
    let providerBody: unknown;
    server.use(
      http.post(GOOGLE_AIR_QUALITY_CURRENT_URL, async ({ request }) => {
        providerUrl = new URL(request.url);
        providerBody = await request.json();
        return HttpResponse.json({
          dateTime: "2026-07-23T06:00:00Z",
          indexes: [
            { code: "uaqi", aqi: 42 },
            { code: "chn_mee", aqi: 31 },
          ],
          pollutants: [
            {
              code: "pm25",
              concentration: {
                value: 18.2,
                units: "MICROGRAMS_PER_CUBIC_METER",
              },
            },
          ],
        });
      }),
    );

    const response = await accept(
      client().airQualityCurrent({
        headers: authenticate(actor),
        body: {
          lat: 39.9042,
          lng: 116.4074,
          languageCode: "zh-CN",
        },
      }),
      [200],
    );

    expectFreeAirQualityResponse(response.body);
    expect(response.body.result).toMatchObject({
      indexes: [
        { code: "uaqi", aqi: 42 },
        { code: "chn_mee", aqi: 31 },
      ],
      pollutants: [{ code: "pm25" }],
    });
    expect(providerUrl?.searchParams.get("key")).toBe(
      "test-google-weather-key",
    );
    expect(providerBody).toStrictEqual({
      location: {
        latitude: 39.9042,
        longitude: 116.4074,
      },
      universalAqi: true,
      extraComputations: ["LOCAL_AQI", "POLLUTANT_CONCENTRATION"],
      languageCode: "zh-CN",
    });
  });

  it("returns Google Air Quality errors without success billing metadata", async () => {
    const actor = createBddApi(context).user();
    await prepareFreeWeatherActor(actor);
    configureProvider();
    server.use(
      http.post(GOOGLE_AIR_QUALITY_CURRENT_URL, () => {
        return HttpResponse.json(
          { error: { message: "Air quality location unavailable" } },
          { status: 400 },
        );
      }),
    );

    const response = await accept(
      client().airQualityCurrent({
        headers: authenticate(actor),
        body: { lat: 39.9042, lng: 116.4074 },
      }),
      [502],
    );

    expect(response.body.error.code).toBe("GOOGLE_AIR_QUALITY_ERROR");
    expect(response.body.error.message).toBe(
      "Air quality location unavailable",
    );
  });

  it("returns Google Weather errors without success billing metadata", async () => {
    const actor = createBddApi(context).user();
    await prepareFreeWeatherActor(actor);
    configureProvider();
    server.use(
      http.get(GOOGLE_WEATHER_CURRENT_URL, () => {
        return HttpResponse.json(
          { error: { message: "Weather location unavailable" } },
          { status: 400 },
        );
      }),
    );

    const response = await accept(
      client().current({
        headers: authenticate(actor),
        body: { lat: 39.9042, lng: 116.4074, units: "metric" },
      }),
      [502],
    );

    expect(response.body.error.code).toBe("GOOGLE_WEATHER_ERROR");
    expect(response.body.error.message).toBe("Weather location unavailable");
  });
});
