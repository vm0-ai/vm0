import type { AppRoute } from "@ts-rest/core";
import {
  healthAuthContract,
  healthContract,
} from "@vm0/api-contracts/contracts/health";

import type { SignalRouteHandler } from "./context/route";
import { apiHealth$, apiHealthAuth$ } from "./routes/health";

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
  {
    route: healthAuthContract.check,
    handler: apiHealthAuth$,
  },
];
