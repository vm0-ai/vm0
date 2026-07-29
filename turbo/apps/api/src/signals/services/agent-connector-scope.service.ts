import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";
import { userConnectors } from "@vm0/db/schema/user-connector";
import {
  zeroAgents,
  type ZeroAgentVisibility,
} from "@vm0/db/schema/zero-agent";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

export interface AgentConnectorScope {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
}

export interface AgentConnectorSlugRow {
  readonly connectorSlug: string;
}

export interface AgentCustomConnectorRow {
  readonly customConnectorId: string;
}

interface ZeroBackedComposeAgent {
  readonly owner: string;
  readonly visibility: ZeroAgentVisibility;
}

async function loadAgentAllowedConnectorSlugRows(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
  },
): Promise<readonly AgentConnectorSlugRow[]> {
  return await db
    .select({ connectorSlug: userConnectors.connectorType })
    .from(userConnectors)
    .where(
      and(
        eq(userConnectors.orgId, args.orgId),
        eq(userConnectors.userId, args.userId),
        eq(userConnectors.agentId, args.agentId),
      ),
    );
}

async function loadAgentAllowedCustomConnectorRows(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
  },
): Promise<readonly AgentCustomConnectorRow[]> {
  return await db
    .select({ customConnectorId: userCustomConnectors.customConnectorId })
    .from(userCustomConnectors)
    .where(
      and(
        eq(userCustomConnectors.orgId, args.orgId),
        eq(userCustomConnectors.userId, args.userId),
        eq(userCustomConnectors.agentId, args.agentId),
      ),
    );
}

export function agentConnectorScopeFromRows(args: {
  readonly connectorRows: readonly AgentConnectorSlugRow[];
  readonly customConnectorRows: readonly AgentCustomConnectorRow[];
}): AgentConnectorScope {
  const allowedConnectorSlugs = args.connectorRows.flatMap((row) => {
    const parsed = connectorSlugSchema.safeParse(row.connectorSlug);
    return parsed.success ? [parsed.data] : [];
  });
  const allowedCustomConnectorIds = args.customConnectorRows.map((row) => {
    return row.customConnectorId;
  });
  return { allowedConnectorSlugs, allowedCustomConnectorIds };
}

export async function loadAgentConnectorScope(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
  },
): Promise<AgentConnectorScope> {
  const [connectorRows, customConnectorRows] = await Promise.all([
    loadAgentAllowedConnectorSlugRows(db, args),
    loadAgentAllowedCustomConnectorRows(db, args),
  ]);
  return agentConnectorScopeFromRows({ connectorRows, customConnectorRows });
}

export async function loadZeroBackedComposeAgent(
  db: ReadonlyDb,
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
