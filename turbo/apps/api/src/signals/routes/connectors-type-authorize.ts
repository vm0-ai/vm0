import { connectorsTypeAuthorizeContract } from "@vm0/api-contracts/contracts/connectors-type-authorize";

import type { RouteEntry } from "../route";
import { createAuthorizeConnectorInner } from "./zero-connectors";

const authorizeConnectorInner$ = createAuthorizeConnectorInner(
  connectorsTypeAuthorizeContract.authorize,
);

export const connectorsTypeAuthorizeRoutes: readonly RouteEntry[] = [
  {
    route: connectorsTypeAuthorizeContract.authorize,
    handler: authorizeConnectorInner$,
  },
];
