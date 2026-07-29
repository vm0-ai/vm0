import { zeroWeatherContract } from "@vm0/api-contracts/contracts/zero-weather";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { zeroAirQualityCurrent$ } from "../services/zero-air-quality.service";
import {
  zeroWeatherCurrent$,
  zeroWeatherForecastDaily$,
  zeroWeatherForecastHourly$,
  zeroWeatherHistoryHourly$,
} from "../services/zero-weather.service";

const currentBody$ = bodyResultOf(zeroWeatherContract.current);
const forecastHourlyBody$ = bodyResultOf(zeroWeatherContract.forecastHourly);
const forecastDailyBody$ = bodyResultOf(zeroWeatherContract.forecastDaily);
const historyHourlyBody$ = bodyResultOf(zeroWeatherContract.historyHourly);
const airQualityCurrentBody$ = bodyResultOf(
  zeroWeatherContract.airQualityCurrent,
);

const currentInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(currentBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    zeroWeatherCurrent$,
    { auth, body: bodyResult.data },
    signal,
  );
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
      zeroWeatherForecastHourly$,
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
      zeroWeatherForecastDaily$,
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
      zeroWeatherHistoryHourly$,
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
      zeroAirQualityCurrent$,
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

export const zeroWeatherRoutes: readonly RouteEntry[] = [
  {
    route: zeroWeatherContract.current,
    handler: authRoute(weatherAuth, currentInner$),
  },
  {
    route: zeroWeatherContract.forecastHourly,
    handler: authRoute(weatherAuth, forecastHourlyInner$),
  },
  {
    route: zeroWeatherContract.forecastDaily,
    handler: authRoute(weatherAuth, forecastDailyInner$),
  },
  {
    route: zeroWeatherContract.historyHourly,
    handler: authRoute(weatherAuth, historyHourlyInner$),
  },
  {
    route: zeroWeatherContract.airQualityCurrent,
    handler: authRoute(weatherAuth, airQualityCurrentInner$),
  },
];
