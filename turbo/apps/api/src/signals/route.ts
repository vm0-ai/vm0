import type { AppRoute } from "@ts-rest/core";
import { healthContract } from "@vm0/api-contracts/contracts/health";

import type { SignalRouteHandler } from "./context/route";
import { apiHealth$ } from "./routes/health";
import { healthAuthProbeRoutes } from "./routes/health-auth-probe";

export type { SignalRouteHandler };

export interface RouteEntry {
  readonly route: AppRoute;
  readonly handler: SignalRouteHandler<unknown>;
}

export const ROUTES: readonly RouteEntry[] = [
  {
    route: healthContract.check,
    handler: apiHealth$,
  },
  ...healthAuthProbeRoutes,
];
