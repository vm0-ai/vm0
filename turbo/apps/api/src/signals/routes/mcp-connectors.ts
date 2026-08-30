import { computed } from "ccstate";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import { runMcpConnectorList } from "../services/run-mcp-connectors.service";

const listRunMcpConnectorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("Run MCP connector route requires agent authentication");
  }
  const connectors = await get(
    runMcpConnectorList({
      orgId: auth.orgId,
      userId: auth.userId,
      runId: auth.runId,
    }),
  );
  return { status: 200 as const, body: { connectors: [...connectors] } };
});

export const mcpConnectorsRoutes: readonly RouteEntry[] = [
  {
    route: mcpConnectorsContract.list,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:read",
      },
      listRunMcpConnectorsInner$,
    ),
  },
];
