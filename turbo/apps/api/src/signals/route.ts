import type {
  AppRoute,
  HTTPStatusCode,
  ServerInferResponses,
} from "@ts-rest/core";
import {
  healthAuthContract,
  healthContract,
} from "@vm0/api-contracts/contracts/health";

import { type MaybePromise, type SignalRouteHandler } from "./context/route";
import { apiHealth$, apiHealthAuth$ } from "./routes/health";

export type RouteDefinition<T> = {
  contract: AppRoute;
  handler: SignalRouteHandler<T>;
};

type ContractRouteResult<TContract extends AppRoute> = MaybePromise<
  ServerInferResponses<TContract, HTTPStatusCode, "force">
>;

export function contractRoute<TContract extends AppRoute>(definition: {
  readonly contract: TContract;
  readonly handler: SignalRouteHandler<ContractRouteResult<TContract>>;
}): RouteDefinition<ContractRouteResult<TContract>> {
  return {
    contract: definition.contract,
    handler: definition.handler,
  };
}

export const ROUTES = [
  contractRoute({
    contract: healthContract.check,
    handler: apiHealth$,
  }),
  contractRoute({
    contract: healthAuthContract.check,
    handler: apiHealthAuth$,
  }),
] as const satisfies ReadonlyArray<RouteDefinition<unknown>>;
