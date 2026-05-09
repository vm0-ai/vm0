import { computed } from "ccstate";
import {
  zeroComputerConnectorContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
  zeroConnectorsSearchContract,
} from "@vm0/api-contracts/contracts/zero-connectors";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { notFound } from "../../lib/error";
import {
  zeroConnectorByType,
  zeroConnectorList,
  zeroConnectorScopeDiff,
  zeroConnectorSearch,
} from "../services/zero-connector-data.service";
import type { RouteEntry } from "../route";

const connectorReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector:read",
} as const;

const getConnectorListInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const result = await get(
    zeroConnectorList({ orgId: auth.orgId, userId: auth.userId }),
  );
  return { status: 200 as const, body: result };
});

const getConnectorByTypeInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroConnectorsByTypeContract.get));
  const connector = await get(
    zeroConnectorByType({
      orgId: auth.orgId,
      userId: auth.userId,
      type: params.type,
    }),
  );
  if (!connector) {
    return notFound("Connector not found");
  }

  return { status: 200 as const, body: connector };
});

const getComputerConnectorInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const connector = await get(
    zeroConnectorByType({
      orgId: auth.orgId,
      userId: auth.userId,
      type: "computer",
    }),
  );
  if (!connector) {
    return notFound("Computer connector not found");
  }

  return { status: 200 as const, body: connector };
});

const getScopeDiffInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroConnectorScopeDiffContract.getScopeDiff));
  const diff = await get(
    zeroConnectorScopeDiff({
      orgId: auth.orgId,
      userId: auth.userId,
      type: params.type,
    }),
  );
  if (!diff) {
    return notFound("Connector not found");
  }

  return { status: 200 as const, body: diff };
});

const searchConnectorsInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const query = get(queryOf(zeroConnectorsSearchContract.search));
  const connectors = await get(
    zeroConnectorSearch({
      orgId: auth.orgId,
      userId: auth.userId,
      keyword: query.keyword,
    }),
  );
  return { status: 200 as const, body: { connectors: [...connectors] } };
});

export const zeroConnectorsRoutes: readonly RouteEntry[] = [
  {
    route: zeroComputerConnectorContract.get,
    handler: authRoute(connectorReadAuth, getComputerConnectorInner$),
  },
  {
    route: zeroConnectorsSearchContract.search,
    handler: authRoute({}, searchConnectorsInner$),
  },
  {
    route: zeroConnectorsMainContract.list,
    handler: authRoute(connectorReadAuth, getConnectorListInner$),
  },
  {
    route: zeroConnectorScopeDiffContract.getScopeDiff,
    handler: authRoute(connectorReadAuth, getScopeDiffInner$),
  },
  {
    route: zeroConnectorsByTypeContract.get,
    handler: authRoute(connectorReadAuth, getConnectorByTypeInner$),
  },
];
