import { zeroFinanceContract } from "@vm0/api-contracts/contracts/zero-finance";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { zeroFinance$ } from "../services/zero-finance.service";

const searchBody$ = bodyResultOf(zeroFinanceContract.search);
const profileBody$ = bodyResultOf(zeroFinanceContract.profile);
const quoteBody$ = bodyResultOf(zeroFinanceContract.quote);
const chartBody$ = bodyResultOf(zeroFinanceContract.chart);

const zeroFinanceDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Zero Finance is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const zeroFinanceEnabled$ = command(async ({ get }) => {
  const auth = get(organizationAuthContext$);
  const context = await loadUserFeatureSwitchContext(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.ZeroFinance, context);
});

const searchInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(zeroFinanceEnabled$))) {
    return zeroFinanceDisabled;
  }
  signal.throwIfAborted();
  const bodyResult = await get(searchBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    zeroFinance$,
    { auth, request: { operation: "search", body: bodyResult.data } },
    signal,
  );
});

const profileInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(zeroFinanceEnabled$))) {
    return zeroFinanceDisabled;
  }
  signal.throwIfAborted();
  const bodyResult = await get(profileBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    zeroFinance$,
    { auth, request: { operation: "profile", body: bodyResult.data } },
    signal,
  );
});

const quoteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(zeroFinanceEnabled$))) {
    return zeroFinanceDisabled;
  }
  signal.throwIfAborted();
  const bodyResult = await get(quoteBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    zeroFinance$,
    { auth, request: { operation: "quote", body: bodyResult.data } },
    signal,
  );
});

const chartInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(zeroFinanceEnabled$))) {
    return zeroFinanceDisabled;
  }
  signal.throwIfAborted();
  const bodyResult = await get(chartBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    zeroFinance$,
    { auth, request: { operation: "chart", body: bodyResult.data } },
    signal,
  );
});

const financeAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "finance:read",
} as const;

export const zeroFinanceRoutes: readonly RouteEntry[] = [
  {
    route: zeroFinanceContract.search,
    handler: authRoute(financeAuth, searchInner$),
  },
  {
    route: zeroFinanceContract.profile,
    handler: authRoute(financeAuth, profileInner$),
  },
  {
    route: zeroFinanceContract.quote,
    handler: authRoute(financeAuth, quoteInner$),
  },
  {
    route: zeroFinanceContract.chart,
    handler: authRoute(financeAuth, chartInner$),
  },
];
