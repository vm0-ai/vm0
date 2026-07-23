import { command, computed, type Computed } from "ccstate";
import type { ComposeListItem } from "@vm0/api-contracts/contracts/composes";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { storages } from "@vm0/db/schema/storage";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import {
  getInstructionsStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import { and, desc, eq, inArray } from "drizzle-orm";

import { db$, writeDb$ } from "../external/db";
import { deleteS3Objects, listS3ObjectsUnderPrefix } from "../external/s3";
import { env } from "../../lib/env";
import { conflict } from "../../lib/error";

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

type ConflictResponse = ReturnType<typeof conflict>;

const ACTIVE_RUN_STATUSES = ["pending", "running"] as const;

export const deleteComposeById$ = command(
  async (
    { get, set },
    args: {
      readonly composeId: string;
      readonly composeName: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<ConflictResponse | undefined> => {
    const writeDb = set(writeDb$);

    const result = await writeDb.transaction(async (tx) => {
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

      const storageName = getInstructionsStorageName(args.composeName);
      const [storage] = await tx
        .select({ id: storages.id, s3Prefix: storages.s3Prefix })
        .from(storages)
        .where(
          and(
            eq(storages.orgId, args.orgId),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            eq(storages.name, storageName),
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

    if (result.kind === "conflict") {
      return conflict("Cannot delete agent: agent is currently running");
    }

    if (result.s3Prefix) {
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      const objects = await get(
        listS3ObjectsUnderPrefix(bucket, result.s3Prefix),
      );
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
