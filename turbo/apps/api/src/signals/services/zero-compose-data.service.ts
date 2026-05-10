import { command, computed, type Computed } from "ccstate";
import type {
  ComposeListItem,
  ComposeResponse,
} from "@vm0/api-contracts/contracts/composes";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { storages } from "@vm0/db/schema/storage";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { getInstructionsStorageName } from "@vm0/core/storage-names";
import { and, desc, eq, inArray } from "drizzle-orm";

import { db$, writeDb$ } from "../external/db";
import { deleteS3Objects, listS3Objects } from "../external/s3";
import { nowDate } from "../external/time";
import { env } from "../../lib/env";
import { conflict, notFound } from "../../lib/error";

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

type NotFoundResponse = ReturnType<typeof notFound>;
type ConflictResponse = ReturnType<typeof conflict>;

const ACTIVE_RUN_STATUSES = ["pending", "running"] as const;

export const deleteCompose$ = command(
  async (
    { get, set },
    args: { readonly composeId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<NotFoundResponse | ConflictResponse | undefined> => {
    const writeDb = set(writeDb$);

    const result = await writeDb.transaction(async (tx) => {
      const [compose] = await tx
        .select({
          id: agentComposes.id,
          name: agentComposes.name,
          orgId: agentComposes.orgId,
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
        return { kind: "not-found" as const };
      }

      const [activeRun] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .innerJoin(
          agentComposeVersions,
          eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
        )
        .where(
          and(
            eq(agentComposeVersions.composeId, args.composeId),
            inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
          ),
        )
        .limit(1);

      if (activeRun) {
        return { kind: "conflict" as const };
      }

      const versionRows = await tx
        .select({ id: agentComposeVersions.id })
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.composeId, args.composeId));

      if (versionRows.length > 0) {
        await tx.delete(agentRuns).where(
          inArray(
            agentRuns.agentComposeVersionId,
            versionRows.map((row) => {
              return row.id;
            }),
          ),
        );
      }

      await tx
        .delete(agentComposes)
        .where(eq(agentComposes.id, args.composeId));

      const storageName = getInstructionsStorageName(compose.name);
      const [storage] = await tx
        .select({ id: storages.id, s3Prefix: storages.s3Prefix })
        .from(storages)
        .where(
          and(
            eq(storages.orgId, compose.orgId),
            eq(storages.name, storageName),
            eq(storages.type, "volume"),
          ),
        )
        .limit(1);

      if (storage) {
        await tx.delete(storages).where(eq(storages.id, storage.id));
      }

      return {
        kind: "deleted" as const,
        s3Prefix: storage?.s3Prefix ?? null,
      };
    });
    signal.throwIfAborted();

    if (result.kind === "not-found") {
      return notFound("Agent not found");
    }
    if (result.kind === "conflict") {
      return conflict("Cannot delete agent: agent is currently running");
    }

    if (result.s3Prefix) {
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      const objects = await get(listS3Objects(bucket, result.s3Prefix));
      signal.throwIfAborted();
      await get(
        deleteS3Objects(
          bucket,
          objects.map((obj) => {
            return obj.key;
          }),
        ),
      );
      signal.throwIfAborted();
    }

    return undefined;
  },
);

export const updateComposeMetadata$ = command(
  async (
    { set },
    args: {
      readonly composeId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly body: {
        readonly displayName?: string | null;
        readonly description?: string | null;
        readonly sound?: string | null;
      };
    },
    signal: AbortSignal,
  ): Promise<NotFoundResponse | undefined> => {
    const writeDb = set(writeDb$);

    // Match apps/web's access semantics: canAccessCompose allows the compose's
    // owner OR any user in the compose's org. Migration policy keeps logic
    // unchanged — do not narrow to user-only without explicit approval.
    const [compose] = await writeDb
      .select({
        id: agentComposes.id,
        userId: agentComposes.userId,
        orgId: agentComposes.orgId,
        name: agentComposes.name,
      })
      .from(agentComposes)
      .where(eq(agentComposes.id, args.composeId))
      .limit(1);
    signal.throwIfAborted();

    if (!compose || !canAccessCompose(args.userId, args.orgId, compose)) {
      return notFound("Agent compose not found");
    }

    const { body } = args;
    await writeDb
      .insert(zeroAgents)
      .values({
        id: compose.id,
        orgId: compose.orgId,
        owner: compose.userId,
        name: compose.name,
        displayName: body.displayName ?? null,
        description: body.description ?? null,
        sound: body.sound ?? null,
      })
      .onConflictDoUpdate({
        target: [zeroAgents.orgId, zeroAgents.name],
        set: {
          ...(body.displayName !== undefined && {
            displayName: body.displayName,
          }),
          ...(body.description !== undefined && {
            description: body.description,
          }),
          ...(body.sound !== undefined && { sound: body.sound }),
          updatedAt: nowDate(),
        },
      });
    signal.throwIfAborted();

    return undefined;
  },
);
