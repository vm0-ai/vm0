import { weatherContract } from "@okouai/api-contracts/contracts/weather";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { airQualityCurrent$ } from "../services/air-quality.service";
import {
  weatherCurrent$,
  weatherForecastDaily$,
  weatherForecastHourly$,
  weatherHistoryHourly$,
} from "../services/weather.service";

const currentBody$ = bodyResultOf(weatherContract.current);
const forecastHourlyBody$ = bodyResultOf(weatherContract.forecastHourly);
const forecastDailyBody$ = bodyResultOf(weatherContract.forecastDaily);
const historyHourlyBody$ = bodyResultOf(weatherContract.historyHourly);
const airQualityCurrentBody$ = bodyResultOf(weatherContract.airQualityCurrent);

const currentInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(currentBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(weatherCurrent$, { auth, body: bodyResult.data }, signal);
});

const forecastHourlyInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(forecastHourlyBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      weatherForecastHourly$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

const forecastDailyInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(forecastDailyBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      weatherForecastDaily$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

const historyHourlyInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(historyHourlyBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      weatherHistoryHourly$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

const airQualityCurrentInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(airQualityCurrentBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      airQualityCurrent$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

const weatherAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "weather:read",
} as const;

export const weatherRoutes: readonly RouteEntry[] = [
  {
    route: weatherContract.current,
    handler: authRoute(weatherAuth, currentInner$),
  },
  {
    route: weatherContract.forecastHourly,
    handler: authRoute(weatherAuth, forecastHourlyInner$),
  },
  {
    route: weatherContract.forecastDaily,
    handler: authRoute(weatherAuth, forecastDailyInner$),
  },
  {
    route: weatherContract.historyHourly,
    handler: authRoute(weatherAuth, historyHourlyInner$),
  },
  {
    route: weatherContract.airQualityCurrent,
    handler: authRoute(weatherAuth, airQualityCurrentInner$),
  },
];
