import { computed, type Computed } from "ccstate";
import type { ZeroAgentResponse } from "@vm0/api-contracts/contracts/zero-agents";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { connectorTypeSchema } from "@vm0/connectors/connectors";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, desc, eq, isNull, or } from "drizzle-orm";

import { db$ } from "../external/db";

export function agentResponse(row: {
  readonly agentId: string;
  readonly owner: string | null;
  readonly composeUserId?: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly sound: string | null;
  readonly avatarUrl: string | null;
  readonly customSkills: readonly string[];
  readonly modelProviderId: string | null;
  readonly selectedModel: string | null;
  readonly preferPersonalProvider: boolean;
  readonly visibility: "public" | "private";
}): ZeroAgentResponse {
  return {
    agentId: row.agentId,
    ownerId: row.owner ?? row.composeUserId ?? "",
    displayName: row.displayName,
    description: row.description,
    sound: row.sound,
    avatarUrl: row.avatarUrl,
    customSkills: [...row.customSkills],
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
    avatarUrl: null,
    customSkills: [],
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
        customSkills: zeroAgents.customSkills,
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
        customSkills: zeroAgents.customSkills,
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

export function zeroAgentEnabledConnectorTypes(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}): Computed<Promise<readonly string[]>> {
  return computed(async (get): Promise<readonly string[]> => {
    const rows = await get(db$)
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
  });
}

export function zeroAgentEnabledCustomConnectorIds(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}): Computed<Promise<readonly string[]>> {
  return computed(async (get): Promise<readonly string[]> => {
    const rows = await get(db$)
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
  });
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
        customSkills: zeroAgents.customSkills,
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
        customSkills: [...row.customSkills],
        visibility: row.visibility,
        headVersionId: row.headVersionId,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  });
}
