import {
  connectorTypeSchema,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";
import { userConnectors } from "@vm0/db/schema/user-connector";
import {
  zeroAgents,
  type ZeroAgentVisibility,
} from "@vm0/db/schema/zero-agent";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";

interface AgentConnectorScope {
  readonly allowedConnectorTypes: readonly ConnectorType[];
  readonly allowedCustomConnectorIds: readonly string[];
}

interface ZeroBackedComposeAgent {
  readonly owner: string;
  readonly visibility: ZeroAgentVisibility;
}

async function loadAgentAllowedConnectorTypes(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
  },
): Promise<readonly ConnectorType[]> {
  const rows = await db
    .select({ connectorType: userConnectors.connectorType })
    .from(userConnectors)
    .where(
      and(
        eq(userConnectors.orgId, args.orgId),
        eq(userConnectors.userId, args.userId),
        eq(userConnectors.agentId, args.agentId),
      ),
    );

  return rows.flatMap((row) => {
    const parsed = connectorTypeSchema.safeParse(row.connectorType);
    return parsed.success ? [parsed.data] : [];
  });
}

async function loadAgentAllowedCustomConnectorIds(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
  },
): Promise<readonly string[]> {
  const rows = await db
    .select({ customConnectorId: userCustomConnectors.customConnectorId })
    .from(userCustomConnectors)
    .where(
      and(
        eq(userCustomConnectors.orgId, args.orgId),
        eq(userCustomConnectors.userId, args.userId),
        eq(userCustomConnectors.agentId, args.agentId),
      ),
    );

  return rows.map((row) => {
    return row.customConnectorId;
  });
}

export async function loadAgentConnectorScope(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
  },
): Promise<AgentConnectorScope> {
  const [allowedConnectorTypes, allowedCustomConnectorIds] = await Promise.all([
    loadAgentAllowedConnectorTypes(db, args),
    loadAgentAllowedCustomConnectorIds(db, args),
  ]);
  return { allowedConnectorTypes, allowedCustomConnectorIds };
}

export async function loadZeroBackedComposeAgent(
  db: Db,
  args: {
    readonly composeId: string;
  },
): Promise<ZeroBackedComposeAgent | null> {
  // The caller must verify agent_composes.org_id first. zero_agents.org_id is
  // denormalized and must not decide whether a resolved compose is Zero-backed.
  const [agent] = await db
    .select({
      id: zeroAgents.id,
      owner: zeroAgents.owner,
      visibility: zeroAgents.visibility,
    })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, args.composeId))
    .limit(1);
  if (!agent) {
    return null;
  }
  return { owner: agent.owner, visibility: agent.visibility };
}
