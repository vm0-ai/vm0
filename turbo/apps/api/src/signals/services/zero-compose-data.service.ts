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
import { and, desc, eq } from "drizzle-orm";

import { db$ } from "../external/db";

type ComposeContent = ComposeResponse["content"];

function canAccessCompose(
  userId: string,
  orgId: string,
  compose: { readonly userId: string; readonly orgId: string },
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
    content: (row.content as ComposeContent) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function zeroComposeByName(args: {
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

export function zeroComposeExists(args: {
  readonly orgId: string;
  readonly composeId: string;
}): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const [row] = await get(db$)
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.orgId, args.orgId),
          eq(agentComposes.id, args.composeId),
        ),
      )
      .limit(1);

    return Boolean(row);
  });
}

export function zeroComposeById(args: {
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

export function zeroComposeList(
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
