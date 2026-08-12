import type { UsagePricingResolution } from "../signals/context/usage-pricing-resolution";
import type { RouteEntry } from "../signals/route-entry";
import { setupAppWithRoutes } from "./test-app";
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
