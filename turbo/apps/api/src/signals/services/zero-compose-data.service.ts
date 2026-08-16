import { command, computed, type Computed } from "ccstate";
import {
  agentComposes,
  agentComposeVersions,
} from "@okouai/db/schema/agent-compose";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { storages } from "@okouai/db/schema/storage";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import {
  getInstructionsStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db$, writeDb$ } from "../external/db";
import type { Tx } from "../../lib/db-types";
import { deleteS3Objects, listS3ObjectsUnderPrefix } from "../external/s3";
import { env } from "../../lib/env";
import { conflict } from "../../lib/error";
import { isLockNotAvailable } from "../../lib/pg-errors";
import { settle } from "../utils";
import { reconcileAutomationEventWatches } from "./automation-event-watch-lifecycle.service";

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

type ConflictResponse = ReturnType<typeof conflict>;

const DELETE_AGENT_LOCK_TIMEOUT = "100ms";

interface DeleteComposeArgs {
  readonly composeId: string;
  readonly composeName: string;
  readonly orgId: string;
}

async function lockAgentLifecycleForDeletion(tx: Tx, args: DeleteComposeArgs) {
  const [agent] = await tx
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.id, args.composeId),
        eq(agentComposes.orgId, args.orgId),
      ),
    )
    .for("update", { noWait: true })
    .limit(1);

  if (!agent) {
    return { kind: "missing" as const };
  }

  const [legacyVersion] = await tx
    .select({ id: agentComposeVersions.id })
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.composeId, args.composeId))
    .limit(1);

  // Temporary Stage 0 safety veto. Remove only when #26938's final
  // version-contract stage has removed every legacy version dependency.
  if (legacyVersion) {
    return { kind: "legacy-version" as const };
  }

  const sessions = await tx
    .select({ id: agentSessions.id, orgId: agentSessions.orgId })
    .from(agentSessions)
    .where(eq(agentSessions.agentComposeId, args.composeId))
    .orderBy(asc(agentSessions.id))
    .for("update", { noWait: true });

  if (
    sessions.some((session) => {
      return session.orgId !== args.orgId;
    })
  ) {
    return { kind: "ownership-conflict" as const };
  }

  const runs =
    sessions.length === 0
      ? []
      : await tx
          .select({
            id: agentRuns.id,
            orgId: agentRuns.orgId,
            status: agentRuns.status,
          })
          .from(agentRuns)
          .where(
            inArray(
              agentRuns.sessionId,
              sessions.map((session) => {
                return session.id;
              }),
            ),
          )
          .orderBy(asc(agentRuns.id))
          .for("update", { noWait: true });

  if (
    runs.some((run) => {
      return run.orgId !== args.orgId;
    })
  ) {
    return { kind: "ownership-conflict" as const };
  }

  if (
    runs.some((run) => {
      return run.status === "pending" || run.status === "running";
    })
  ) {
    return { kind: "active-run" as const };
  }

  return { kind: "ready" as const };
}

async function deleteComposeInTransaction(tx: Tx, args: DeleteComposeArgs) {
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${DELETE_AGENT_LOCK_TIMEOUT}, true)`,
  );

  const lifecycle = await lockAgentLifecycleForDeletion(tx, args);
  if (lifecycle.kind !== "ready") {
    return lifecycle;
  }

  const automations = await tx
    .select({
      orgId: workflowAutomations.orgId,
      ownerUserId: workflowAutomations.ownerUserId,
      eventType: workflowAutomations.eventType,
      eventConfig: workflowAutomations.eventConfig,
    })
    .from(workflowAutomations)
    .innerJoin(workflows, eq(workflowAutomations.workflowId, workflows.id))
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.agentId, args.composeId),
      ),
    );

  await tx
    .delete(agentComposes)
    .where(
      and(
        eq(agentComposes.id, args.composeId),
        eq(agentComposes.orgId, args.orgId),
      ),
    );

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
    automations,
  };
}

export const deleteComposeById$ = command(
  async (
    { get, set },
    args: DeleteComposeArgs,
    signal: AbortSignal,
  ): Promise<ConflictResponse | undefined> => {
    const writeDb = set(writeDb$);

    const transaction = await settle(
      writeDb.transaction(async (tx) => {
        return await deleteComposeInTransaction(tx, args);
      }),
      signal,
    );
    if (!transaction.ok) {
      if (isLockNotAvailable(transaction.error)) {
        return conflict("Cannot delete agent right now; retry shortly");
      }
      throw transaction.error;
    }
    const result = transaction.value;
    signal.throwIfAborted();

    if (result.kind === "legacy-version") {
      return conflict(
        "Cannot delete agent while its configuration is being migrated",
      );
    }

    if (result.kind === "ownership-conflict") {
      return conflict(
        "Cannot delete agent because its lifecycle ownership is inconsistent",
      );
    }

    if (result.kind === "active-run") {
      return conflict("Cannot delete agent: agent is currently running");
    }

    if (result.kind === "missing") {
      return undefined;
    }

    await reconcileAutomationEventWatches(
      {
        db: writeDb,
        automations: result.automations,
      },
      signal,
    );
    signal.throwIfAborted();

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
