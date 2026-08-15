import type { UsagePricingResolution } from "../signals/context/usage-pricing-resolution";
import type { RouteEntry } from "../signals/route-entry";
import { setupAppWithRoutes, setupRawAppRequestWithRoutes } from "./test-app";
import type { TestContext } from "./test-context";

interface SetupAppOptions {
  readonly context: TestContext;
  readonly routes: readonly RouteEntry[];
  readonly signal?: AbortSignal;
  readonly usagePricingResolution?: UsagePricingResolution;
}

export function setupApp({
  context,
  routes,
  signal,
  usagePricingResolution,
}: SetupAppOptions) {
  return setupAppWithRoutes({
    context,
    routes,
    signal,
    usagePricingResolution,
  });
}

/**
 * Use only for request shapes the route's contract makes unrepresentable in
 * TypeScript. Prefer `setupApp` for every case the typed client can express.
 */
export function setupRawAppRequest({
  context,
  routes,
  signal,
}: SetupAppOptions) {
  return setupRawAppRequestWithRoutes({ context, routes, signal });
}
