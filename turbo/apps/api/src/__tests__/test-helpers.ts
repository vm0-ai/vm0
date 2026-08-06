import type { RouteEntry } from "../signals/route-entry";
import { setupAppWithRoutes } from "./test-app";
import type { TestContext } from "./test-context";

interface SetupAppOptions {
  readonly context: TestContext;
  readonly routes: readonly RouteEntry[];
}

export function setupApp({ context, routes }: SetupAppOptions) {
  return setupAppWithRoutes({ context, routes });
}
