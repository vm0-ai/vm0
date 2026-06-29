import { computed, type Computed } from "ccstate";
import type {
  ComposeListItem,
  ComposeResponse,
} from "@vm0/api-contracts/contracts/composes";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, desc, eq, like } from "drizzle-orm";

import { badRequestMessage, notFound } from "../../lib/error";
import { db$ } from "../external/db";

type AgentComposeNotFoundResponse = ReturnType<typeof notFound>;
type AgentComposeBadRequestResponse = ReturnType<typeof badRequestMessage>;

interface ComposeAccessRow {
  readonly userId: string;
  readonly orgId: string;
}

interface VersionResolution {
  readonly versionId: string;
  readonly tag?: string;
}

function canAccessCompose(
  userId: string,
  orgId: string,
  compose: ComposeAccessRow,
): boolean {
  return compose.orgId === orgId || compose.userId === userId;
}

function composeResponse(row: {
  readonly id: string;
  readonly name: string;
  readonly headVersionId: string | null;
  readonly content: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): ComposeResponse {
  return {
    id: row.id,
    name: row.name,
    headVersionId: row.headVersionId,
    content: (row.content as ComposeResponse["content"]) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function agentComposeOrgId(
  composeId: string,
): Computed<Promise<string | null>> {
  return computed(async (get): Promise<string | null> => {
    const [row] = await get(db$)
      .select({ orgId: agentComposes.orgId })
      .from(agentComposes)
      .where(eq(agentComposes.id, composeId))
      .limit(1);

    return row?.orgId ?? null;
  });
}

export function agentComposeByName(args: {
  readonly orgId: string;
  readonly name: string;
}): Computed<Promise<ComposeResponse | null>> {
  return computed(async (get): Promise<ComposeResponse | null> => {
    const [row] = await get(db$)
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        headVersionId: agentComposes.headVersionId,
        createdAt: agentComposes.createdAt,
        updatedAt: agentComposes.updatedAt,
        content: agentComposeVersions.content,
      })
      .from(agentComposes)
      .leftJoin(
        agentComposeVersions,
        eq(agentComposes.headVersionId, agentComposeVersions.id),
      )
      .where(
        and(
          eq(agentComposes.orgId, args.orgId),
          eq(agentComposes.name, args.name),
        ),
      )
      .limit(1);

    return row ? composeResponse(row) : null;
  });
}

export function agentComposeById(args: {
  readonly composeId: string;
  readonly userId: string;
  readonly orgId: string;
}): Computed<Promise<ComposeResponse | null>> {
  return computed(async (get): Promise<ComposeResponse | null> => {
    const [row] = await get(db$)
      .select({
        id: agentComposes.id,
        userId: agentComposes.userId,
        orgId: agentComposes.orgId,
        name: agentComposes.name,
        headVersionId: agentComposes.headVersionId,
        createdAt: agentComposes.createdAt,
        updatedAt: agentComposes.updatedAt,
        content: agentComposeVersions.content,
      })
      .from(agentComposes)
      .leftJoin(
        agentComposeVersions,
        eq(agentComposes.headVersionId, agentComposeVersions.id),
      )
      .where(eq(agentComposes.id, args.composeId))
      .limit(1);

    if (!row || !canAccessCompose(args.userId, args.orgId, row)) {
      return null;
    }

    return composeResponse(row);
  });
}

export function agentComposeList(
  orgId: string,
): Computed<Promise<{ readonly composes: readonly ComposeListItem[] }>> {
  return computed(async (get) => {
    const rows = await get(db$)
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        headVersionId: agentComposes.headVersionId,
        updatedAt: agentComposes.updatedAt,
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
      })
      .from(agentComposes)
      .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(eq(agentComposes.orgId, orgId))
      .orderBy(desc(agentComposes.updatedAt));

    return {
      composes: rows.map((row) => {
        return {
          id: row.id,
          name: row.name,
          displayName: row.displayName,
          description: row.description,
          sound: row.sound,
          headVersionId: row.headVersionId,
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
    };
  });
}

export function agentComposeVersionResolution(args: {
  readonly composeId: string;
  readonly userId: string;
  readonly version: string;
}): Computed<
  Promise<
    | VersionResolution
    | AgentComposeNotFoundResponse
    | AgentComposeBadRequestResponse
  >
> {
  return computed(async (get) => {
    const [compose] = await get(db$)
      .select({
        id: agentComposes.id,
        headVersionId: agentComposes.headVersionId,
      })
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.id, args.composeId),
          eq(agentComposes.userId, args.userId),
        ),
      )
      .limit(1);

    if (!compose) {
      return notFound("Agent compose not found");
    }

    if (args.version === "latest") {
      if (!compose.headVersionId) {
        return badRequestMessage(
          "Agent compose has no versions. Run 'vm0 build' first.",
        );
      }

      return { versionId: compose.headVersionId, tag: "latest" };
    }

    if (args.version.length === 64) {
      const [exactMatch] = await get(db$)
        .select({ id: agentComposeVersions.id })
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, args.version))
        .limit(1);

      if (!exactMatch) {
        return notFound(`Version '${args.version.slice(0, 8)}...' not found`);
      }

      return { versionId: exactMatch.id };
    }

    const prefixMatches = await get(db$)
      .select({ id: agentComposeVersions.id })
      .from(agentComposeVersions)
      .where(like(agentComposeVersions.id, `${args.version}%`))
      .limit(2);

    if (prefixMatches.length === 0) {
      return notFound(`Version '${args.version}' not found`);
    }

    if (prefixMatches.length > 1) {
      return badRequestMessage(
        `Ambiguous version prefix '${args.version}'. Please use more characters.`,
      );
    }

    const [match] = prefixMatches;
    if (!match) {
      return notFound(`Version '${args.version}' not found`);
    }

    return { versionId: match.id };
  });
}
