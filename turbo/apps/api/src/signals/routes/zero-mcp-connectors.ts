import { computed } from "ccstate";
import { zeroMcpConnectorsContract } from "@okouai/api-contracts/contracts/zero-mcp-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import { zeroRunMcpConnectorList } from "../services/zero-run-mcp-connectors.service";

const listRunMcpConnectorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "zero") {
    throw new Error("Run MCP connector route requires Zero authentication");
  }
  const connectors = await get(
    zeroRunMcpConnectorList({
      orgId: auth.orgId,
      userId: auth.userId,
      runId: auth.runId,
    }),
  );
  return { status: 200 as const, body: { connectors: [...connectors] } };
});

export const zeroMcpConnectorsRoutes: readonly RouteEntry[] = [
  {
    route: zeroMcpConnectorsContract.list,
    handler: authRoute(
      {
        accept: ["zero"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:read",
      },
      listRunMcpConnectorsInner$,
    ),
  },
];
