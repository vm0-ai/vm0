import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { userConnectors } from "@okouai/db/schema/user-connector";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

export interface AgentConnectorScope {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
  readonly customConnectorGrants: readonly AgentCustomConnectorGrant[];
}

export interface AgentConnectorSlugRow {
  readonly connectorSlug: string;
}

export interface AgentCustomConnectorRow {
  readonly customConnectorId: string;
  readonly permissionNames: readonly string[];
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
    .select({ connectorSlug: userConnectors.connectorSlug })
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
    .select({
      customConnectorId: userCustomConnectors.customConnectorId,
      permissionNames: userCustomConnectors.permissionNames,
    })
    .from(userCustomConnectors)
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, userCustomConnectors.customConnectorId),
        eq(orgCustomConnectors.orgId, userCustomConnectors.orgId),
      ),
    )
    .where(
      and(
        eq(userCustomConnectors.orgId, args.orgId),
        eq(userCustomConnectors.userId, args.userId),
        eq(userCustomConnectors.agentId, args.agentId),
        eq(orgCustomConnectors.enabled, true),
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
  const customConnectorGrants = args.customConnectorRows.map((row) => {
    return {
      customConnectorId: row.customConnectorId,
      permissionNames: [...row.permissionNames],
    };
  });
  return {
    allowedConnectorSlugs,
    allowedCustomConnectorIds,
    customConnectorGrants,
  };
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
