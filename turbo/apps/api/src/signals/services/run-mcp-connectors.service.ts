import { computed, type Computed } from "ccstate";
import type { McpConnector } from "@okouai/api-contracts/contracts/mcp-connectors";
import {
  agentRuns,
  agentSessions,
} from "@okouai/db/schema/agent-run-session-conversation";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { customConnectorDefinitionSelection } from "./custom-connector-definition-selection";
import {
  customConnectorDefinitionConnectedAccountId,
  customConnectorDefinitionConnectedAccountUpdatedAt,
  loadCurrentCustomConnectorValueMarkers,
  loadConnectedCustomConnectorConnections,
} from "./custom-connector-credential-access.service";
import {
  normaliseCustomConnectorRow,
  serialiseCustomConnector,
} from "./custom-connector.service";

export function runMcpConnectorList(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
}): Computed<Promise<readonly McpConnector[]>> {
  return computed(async (get): Promise<readonly McpConnector[]> => {
    const db = get(db$);
    const rows = await db
      .select({ connector: customConnectorDefinitionSelection() })
      .from(agentRuns)
      .innerJoin(
        agentSessions,
        and(
          eq(agentSessions.id, agentRuns.sessionId),
          eq(agentSessions.orgId, args.orgId),
          eq(agentSessions.userId, args.userId),
        ),
      )
      .innerJoin(
        userCustomConnectors,
        and(
          eq(userCustomConnectors.agentId, agentSessions.agentId),
          eq(userCustomConnectors.orgId, args.orgId),
          eq(userCustomConnectors.userId, args.userId),
        ),
      )
      .innerJoin(
        orgCustomConnectors,
        and(
          eq(orgCustomConnectors.id, userCustomConnectors.customConnectorId),
          eq(orgCustomConnectors.orgId, args.orgId),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.orgId, args.orgId),
          eq(agentRuns.userId, args.userId),
          eq(orgCustomConnectors.enabled, true),
          eq(orgCustomConnectors.mcpTransport, "streamable-http"),
        ),
      )
      .orderBy(orgCustomConnectors.slug);

    const connectorIds = rows.map(({ connector }) => {
      return connector.id;
    });
    const [valueMarkers, connectedConnections] = await Promise.all([
      loadCurrentCustomConnectorValueMarkers(db, {
        orgId: args.orgId,
        userId: args.userId,
        connectorIds,
      }),
      loadConnectedCustomConnectorConnections(db, {
        orgId: args.orgId,
        userId: args.userId,
        connectorIds,
      }),
    ]);

    return rows.map(({ connector }) => {
      const response = serialiseCustomConnector({
        row: normaliseCustomConnectorRow(connector),
        valueMarkers,
        connectedAccountId: customConnectorDefinitionConnectedAccountId({
          connectedConnections,
          definition: connector,
        }),
        connectedAccountUpdatedAt:
          customConnectorDefinitionConnectedAccountUpdatedAt({
            connectedConnections,
            definition: connector,
          }),
      });
      if (response.kind !== "mcp") {
        throw new Error("Run MCP connector query returned a non-MCP connector");
      }
      return {
        id: response.id,
        slug: response.slug,
        displayName: response.displayName,
        transport: response.transport,
        endpoint: response.endpoint,
        connected: response.connected,
      };
    });
  });
}
