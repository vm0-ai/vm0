import { financeContract } from "@okouai/api-contracts/contracts/finance";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { finance$ } from "../services/finance.service";

const searchBody$ = bodyResultOf(financeContract.search);
const profileBody$ = bodyResultOf(financeContract.profile);
const quoteBody$ = bodyResultOf(financeContract.quote);
const chartBody$ = bodyResultOf(financeContract.chart);

const searchInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  signal.throwIfAborted();
  const bodyResult = await get(searchBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    finance$,
    { auth, request: { operation: "search", body: bodyResult.data } },
    signal,
  );
});

const profileInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  signal.throwIfAborted();
  const bodyResult = await get(profileBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    finance$,
    { auth, request: { operation: "profile", body: bodyResult.data } },
    signal,
  );
});

const quoteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  signal.throwIfAborted();
  const bodyResult = await get(quoteBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    finance$,
    { auth, request: { operation: "quote", body: bodyResult.data } },
    signal,
  );
});

const chartInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  signal.throwIfAborted();
  const bodyResult = await get(chartBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    finance$,
    { auth, request: { operation: "chart", body: bodyResult.data } },
    signal,
  );
});

const financeAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "finance:read",
  runUsageBarrier: true,
} as const;

export const financeRoutes: readonly RouteEntry[] = [
  {
    route: financeContract.search,
    handler: authRoute(financeAuth, searchInner$),
  },
  {
    route: financeContract.profile,
    handler: authRoute(financeAuth, profileInner$),
  },
  {
    route: financeContract.quote,
    handler: authRoute(financeAuth, quoteInner$),
  },
  {
    route: financeContract.chart,
    handler: authRoute(financeAuth, chartInner$),
  },
];
