import { computed, type Computed } from "ccstate";
import type { ZeroAgentResponse } from "@vm0/api-contracts/contracts/zero-agents";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";
import type { AgentCustomConnectorGrant } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";

import { db$ } from "../external/db";
import { DEFAULT_AGENT_AVATAR_URL } from "./default-agent-profile";

export function agentResponse(row: {
  readonly agentId: string;
  readonly owner: string | null;
  readonly composeUserId?: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly sound: string | null;
  readonly avatarUrl: string | null;
  readonly modelProviderId: string | null;
  readonly selectedModel: string | null;
  readonly preferPersonalProvider: boolean;
  readonly visibility: "public" | "private";
}): ZeroAgentResponse {
  const ownerId = row.owner ?? row.composeUserId;
  if (!ownerId) {
    throw new Error(`Zero agent ${row.agentId} is missing an owner`);
  }

  return {
    agentId: row.agentId,
    ownerId,
    displayName: row.displayName,
    description: row.description,
    sound: row.sound,
    avatarUrl: row.avatarUrl,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: row.visibility,
  };
}

export function defaultAgentResponse(args: {
  readonly agentId: string;
  readonly ownerId: string;
}): ZeroAgentResponse {
  return {
    agentId: args.agentId,
    ownerId: args.ownerId,
    displayName: null,
    description: null,
    sound: null,
    avatarUrl: DEFAULT_AGENT_AVATAR_URL,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "public",
  };
}

function visibleZeroAgentCondition(userId: string) {
  return or(eq(zeroAgents.visibility, "public"), eq(zeroAgents.owner, userId));
}

export function visibleJoinedZeroAgentCondition(userId: string) {
  return or(
    isNull(zeroAgents.id),
    eq(zeroAgents.visibility, "public"),
    eq(zeroAgents.owner, userId),
  );
}

export function zeroAgentExists(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const [agent] = await get(db$)
      .select({ id: zeroAgents.id })
      .from(zeroAgents)
      .where(
        and(
          eq(zeroAgents.orgId, args.orgId),
          eq(zeroAgents.id, args.agentId),
          visibleZeroAgentCondition(args.userId),
        ),
      )
      .limit(1);

    return Boolean(agent);
  });
}

export function zeroAgentList(
  orgId: string,
  userId: string,
): Computed<Promise<readonly ZeroAgentResponse[]>> {
  return computed(async (get): Promise<readonly ZeroAgentResponse[]> => {
    const rows = await get(db$)
      .select({
        agentId: zeroAgents.id,
        owner: zeroAgents.owner,
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
        avatarUrl: zeroAgents.avatarUrl,
        modelProviderId: zeroAgents.modelProviderId,
        selectedModel: zeroAgents.selectedModel,
        preferPersonalProvider: zeroAgents.preferPersonalProvider,
        visibility: zeroAgents.visibility,
      })
      .from(zeroAgents)
      .innerJoin(agentComposes, eq(zeroAgents.id, agentComposes.id))
      .where(
        and(eq(zeroAgents.orgId, orgId), visibleZeroAgentCondition(userId)),
      )
      .orderBy(desc(zeroAgents.updatedAt));

    return rows.map(agentResponse);
  });
}

export function zeroAgentDetail(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}): Computed<Promise<ZeroAgentResponse | null>> {
  return computed(async (get): Promise<ZeroAgentResponse | null> => {
    const [row] = await get(db$)
      .select({
        agentId: zeroAgents.id,
        owner: zeroAgents.owner,
        composeUserId: agentComposes.userId,
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
        avatarUrl: zeroAgents.avatarUrl,
        modelProviderId: zeroAgents.modelProviderId,
        selectedModel: zeroAgents.selectedModel,
        preferPersonalProvider: zeroAgents.preferPersonalProvider,
        visibility: zeroAgents.visibility,
      })
      .from(zeroAgents)
      .innerJoin(agentComposes, eq(zeroAgents.id, agentComposes.id))
      .where(
        and(
          eq(zeroAgents.orgId, args.orgId),
          eq(zeroAgents.id, args.agentId),
          visibleZeroAgentCondition(args.userId),
        ),
      )
      .limit(1);

    return row ? agentResponse(row) : null;
  });
}

export function zeroAgentEnabledConnectorSlugs(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}): Computed<Promise<readonly ConnectorSlug[]>> {
  return computed(async (get): Promise<readonly ConnectorSlug[]> => {
    const rows = await get(db$)
      .select({ connectorSlug: userConnectors.connectorSlug })
      .from(userConnectors)
      .where(
        and(
          eq(userConnectors.orgId, args.orgId),
          eq(userConnectors.userId, args.userId),
          eq(userConnectors.agentId, args.agentId),
        ),
      )
      .orderBy(asc(userConnectors.connectorSlug));

    return rows.map((row) => {
      return connectorSlugSchema.parse(row.connectorSlug);
    });
  });
}

export function zeroAgentCustomConnectorGrants(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}): Computed<Promise<readonly AgentCustomConnectorGrant[]>> {
  return computed(
    async (get): Promise<readonly AgentCustomConnectorGrant[]> => {
      const rows = await get(db$)
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
            eq(
              orgCustomConnectors.revision,
              userCustomConnectors.connectorRevision,
            ),
          ),
        )
        .where(
          and(
            eq(userCustomConnectors.orgId, args.orgId),
            eq(userCustomConnectors.userId, args.userId),
            eq(userCustomConnectors.agentId, args.agentId),
            eq(orgCustomConnectors.enabled, true),
          ),
        )
        .orderBy(asc(userCustomConnectors.customConnectorId));

      return rows.map((row) => {
        return {
          customConnectorId: row.customConnectorId,
          permissionNames: [...row.permissionNames],
        };
      });
    },
  );
}

export function zeroTeam(
  orgId: string,
  userId: string,
): Computed<Promise<readonly TeamComposeItem[]>> {
  return computed(async (get): Promise<readonly TeamComposeItem[]> => {
    const rows = await get(db$)
      .select({
        id: agentComposes.id,
        headVersionId: agentComposes.headVersionId,
        updatedAt: agentComposes.updatedAt,
        owner: zeroAgents.owner,
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
        avatarUrl: zeroAgents.avatarUrl,
        visibility: zeroAgents.visibility,
      })
      .from(agentComposes)
      .innerJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(
        and(eq(agentComposes.orgId, orgId), visibleZeroAgentCondition(userId)),
      )
      .orderBy(desc(agentComposes.updatedAt));

    return rows.map((row) => {
      return {
        id: row.id,
        ownerId: row.owner,
        displayName: row.displayName,
        description: row.description,
        sound: row.sound,
        avatarUrl: row.avatarUrl,
        visibility: row.visibility,
        headVersionId: row.headVersionId,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  });
}
