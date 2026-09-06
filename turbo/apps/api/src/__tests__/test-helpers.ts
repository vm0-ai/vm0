import type { UsagePricingResolution } from "../signals/context/usage-pricing-resolution";
import type { SystemSkillStorageResolution } from "../signals/context/system-skill-storage-resolution";
import type { RouteEntry } from "../signals/route-entry";
import { setupAppWithRoutes, setupRawAppRequestWithRoutes } from "./test-app";
import type { TestContext } from "./test-context";

interface SetupRawAppOptions {
  readonly context: TestContext;
  readonly routes: readonly RouteEntry[];
  readonly signal?: AbortSignal;
}

interface SetupAppOptions extends SetupRawAppOptions {
  readonly baseUrl?: string;
  readonly rethrowErrors?: boolean;
  readonly usagePricingResolution?: UsagePricingResolution;
  readonly systemSkillStorageResolution?: SystemSkillStorageResolution;
}

export function setupApp({
  baseUrl = "http://api.test",
  context,
  routes,
  signal,
  rethrowErrors,
  usagePricingResolution,
  systemSkillStorageResolution,
}: SetupAppOptions) {
  return setupAppWithRoutes({
    baseUrl,
    context,
    routes,
    signal,
    rethrowErrors,
    usagePricingResolution,
    systemSkillStorageResolution,
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
}: SetupRawAppOptions) {
  return setupRawAppRequestWithRoutes({ context, routes, signal });
}
