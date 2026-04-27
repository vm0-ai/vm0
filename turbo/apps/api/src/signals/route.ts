import type { AppRoute } from "@ts-rest/core";
import {
  healthAuthContract,
  healthContract,
} from "@vm0/api-contracts/contracts/health";

import type { SignalRouteHandler } from "./context/route";
import { apiHealth$, apiHealthAuth$ } from "./routes/health";

export type { SignalRouteHandler };

export const ROUTES = new Map<AppRoute, SignalRouteHandler<unknown>>([
  [healthContract.check, apiHealth$],
  [healthAuthContract.check, apiHealthAuth$],
]);
