import { computed, type Computed } from "ccstate";
import type { ZeroAgentResponse } from "@okouai/api-contracts/contracts/zero-agents";
import type { TeamComposeItem } from "@okouai/api-contracts/contracts/zero-team";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/zero-agent-custom-connectors";
import { agentComposes } from "@okouai/db/schema/agent-compose";
import { userConnectors } from "@okouai/db/schema/user-connector";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { zeroAgents } from "@okouai/db/schema/zero-agent";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import { agentDisplayNameForPublicBrand } from "@okouai/core/public-brand";

import { db$ } from "../external/db";
import { DEFAULT_AGENT_AVATAR_URL } from "./default-agent-profile";

export function agentResponse(
  row: {
    readonly agentId: string;
    readonly defaultAgentId: string | null;
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
  },
  publicBrand: PublicBrand,
): ZeroAgentResponse {
  const ownerId = row.owner ?? row.composeUserId;
  if (!ownerId) {
    throw new Error(`Agent ${row.agentId} is missing an owner`);
  }

  return {
    agentId: row.agentId,
    ownerId,
    displayName: agentDisplayNameForPublicBrand({
      agentId: row.agentId,
      defaultAgentId: row.defaultAgentId,
      displayName: row.displayName,
      publicBrand,
    }),
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

function visibleAgentCondition(userId: string) {
  return or(eq(zeroAgents.visibility, "public"), eq(zeroAgents.owner, userId));
}

export function visibleJoinedAgentCondition(userId: string) {
  return or(
    isNull(zeroAgents.id),
    eq(zeroAgents.visibility, "public"),
    eq(zeroAgents.owner, userId),
  );
}

export function agentExists(args: {
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
          visibleAgentCondition(args.userId),
        ),
      )
      .limit(1);

    return Boolean(agent);
  });
}

export function agentList(
  orgId: string,
  userId: string,
  publicBrand: PublicBrand,
): Computed<Promise<readonly ZeroAgentResponse[]>> {
  return computed(async (get): Promise<readonly ZeroAgentResponse[]> => {
    const rows = await get(db$)
      .select({
        agentId: zeroAgents.id,
        defaultAgentId: orgMetadata.defaultAgentId,
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
      .leftJoin(orgMetadata, eq(orgMetadata.orgId, zeroAgents.orgId))
      .where(and(eq(zeroAgents.orgId, orgId), visibleAgentCondition(userId)))
      .orderBy(desc(zeroAgents.updatedAt));

    return rows.map((row) => {
      return agentResponse(row, publicBrand);
    });
  });
}

export function agentDetail(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly publicBrand: PublicBrand;
}): Computed<Promise<ZeroAgentResponse | null>> {
  return computed(async (get): Promise<ZeroAgentResponse | null> => {
    const [row] = await get(db$)
      .select({
        agentId: zeroAgents.id,
        defaultAgentId: orgMetadata.defaultAgentId,
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
      .leftJoin(orgMetadata, eq(orgMetadata.orgId, zeroAgents.orgId))
      .where(
        and(
          eq(zeroAgents.orgId, args.orgId),
          eq(zeroAgents.id, args.agentId),
          visibleAgentCondition(args.userId),
        ),
      )
      .limit(1);

    return row ? agentResponse(row, args.publicBrand) : null;
  });
}

export function agentEnabledConnectorSlugs(args: {
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

export function agentCustomConnectorGrants(args: {
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

export function teamComposeList(
  orgId: string,
  userId: string,
  publicBrand: PublicBrand,
): Computed<Promise<readonly TeamComposeItem[]>> {
  return computed(async (get): Promise<readonly TeamComposeItem[]> => {
    const rows = await get(db$)
      .select({
        id: agentComposes.id,
        defaultAgentId: orgMetadata.defaultAgentId,
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
      .leftJoin(orgMetadata, eq(orgMetadata.orgId, agentComposes.orgId))
      .where(and(eq(agentComposes.orgId, orgId), visibleAgentCondition(userId)))
      .orderBy(desc(agentComposes.updatedAt));

    return rows.map((row) => {
      return {
        id: row.id,
        ownerId: row.owner,
        displayName: agentDisplayNameForPublicBrand({
          agentId: row.id,
          defaultAgentId: row.defaultAgentId,
          displayName: row.displayName,
          publicBrand,
        }),
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
