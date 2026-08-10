import type { RouteEntry } from "../signals/route-entry";
import { setupAppWithRoutes } from "./test-app";
import type { TestContext } from "./test-context";

interface SetupAppOptions {
  readonly context: TestContext;
  readonly routes: readonly RouteEntry[];
  readonly signal?: AbortSignal;
}

export function setupApp({ context, routes, signal }: SetupAppOptions) {
  return setupAppWithRoutes({ context, routes, signal });
}
