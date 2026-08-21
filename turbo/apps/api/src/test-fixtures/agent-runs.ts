/**
 * Test fixtures for retired agent-run API capabilities.
 *
 * Production no longer exposes direct-run creation or run listing, while the
 * integration suites still need those capabilities to construct and inspect
 * runner state. Keep the exception at this narrow service boundary and assert
 * product behavior through the remaining production routes.
 */
import { createStore } from "ccstate";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import { conversations } from "@okouai/db/schema/conversation";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { storages } from "@okouai/db/schema/storage";
import { and, count, eq, inArray } from "drizzle-orm";

import { db } from "../lib/db";
import { now } from "../lib/time";
import {
  createAgentRun$,
  type CreateAgentRunArgs,
} from "../signals/services/agent-run-create.service";
import { agentRunList } from "../signals/services/agent-runs.service";

const store = createStore();

export type DirectRunFixtureRequest = Omit<
  CreateAgentRunArgs["body"],
  "triggerSource"
> & {
  readonly triggerSource?: TriggerSource;
  readonly connectorScope?: CreateAgentRunArgs["connectorScope"];
  readonly ownedSystemStorageMounts?: readonly {
    readonly storageId: string;
    readonly version?: string;
    readonly mountPath: string;
  }[];
};

async function resolveOwnedSystemStorageMounts(
  mounts: DirectRunFixtureRequest["ownedSystemStorageMounts"],
  signal: AbortSignal,
) {
  if (!mounts || mounts.length === 0) {
    return [];
  }

  const storageIds = mounts.map((mount) => {
    return mount.storageId;
  });
  if (new Set(storageIds).size !== storageIds.length) {
    throw new Error("Owned system storage mount ids must be unique");
  }

  const rows = await db()
    .select({ id: storages.id, name: storages.name })
    .from(storages)
    .where(
      and(
        inArray(storages.id, storageIds),
        eq(storages.orgId, SYSTEM_ORG_ID),
        eq(storages.userId, VOLUME_ORG_USER_ID),
      ),
    );
  signal.throwIfAborted();
  const storageNameById = new Map(
    rows.map((row) => {
      return [row.id, row.name];
    }),
  );

  return mounts.map((mount) => {
    const name = storageNameById.get(mount.storageId);
    if (!name) {
      throw new Error("Owned system storage mount is unavailable");
    }
    return {
      name,
      ...(mount.version === undefined ? {} : { version: mount.version }),
      mountPath: mount.mountPath,
      system: true,
    };
  });
}

export async function createDirectRunFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly body: DirectRunFixtureRequest;
  readonly signal: AbortSignal;
}) {
  const { connectorScope, ownedSystemStorageMounts, ...body } = args.body;
  const resolvedOwnedSystemStorageMounts =
    await resolveOwnedSystemStorageMounts(
      ownedSystemStorageMounts,
      args.signal,
    );
  args.signal.throwIfAborted();
  return await store.set(
    createAgentRun$,
    {
      userId: args.userId,
      orgId: args.orgId,
      apiStartTime: now(),
      modelProviderType: body.modelProviderType,
      connectorScope: connectorScope ?? {
        allowedConnectorSlugs: [],
        allowedCustomConnectorIds: [],
      },
      body: {
        ...body,
        ...(resolvedOwnedSystemStorageMounts.length === 0
          ? {}
          : {
              additionalVolumes: [
                ...(body.additionalVolumes ?? []),
                ...resolvedOwnedSystemStorageMounts,
              ],
            }),
        triggerSource: body.triggerSource ?? "test",
      },
    },
    args.signal,
  );
}

export async function listAgentRunsFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly status?: string;
  readonly agent?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}) {
  return await store.get(
    agentRunList({
      userId: args.userId,
      orgId: args.orgId,
      status: args.status,
      agent: args.agent,
      since: args.since,
      until: args.until,
      limit: args.limit ?? 50,
    }),
  );
}

function exactlyOneCount(
  source: string,
  rows: readonly { readonly count: number }[],
): number {
  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error(
      `Expected exactly one ${source} COUNT row, received ${rows.length}`,
    );
  }
  return row.count;
}

/**
 * Exceptional internal assertion for the Run identity mismatch contract.
 *
 * Production APIs cannot observe the absence of Session, callback,
 * conversation, or checkpoint rows. Keep this fixture narrowly scoped to the
 * contract requirement that an Agent/Session mismatch fails before every
 * launch write; ordinary route tests must continue to verify state through
 * production API surfaces.
 */
export async function readRunIdentityMismatchWriteCountsFixture(args: {
  readonly userId: string;
  readonly orgId: string;
}) {
  const ownedRuns = and(
    eq(agentRuns.userId, args.userId),
    eq(agentRuns.orgId, args.orgId),
  );
  const [runRows, sessionRows, callbackRows, conversationRows, checkpointRows] =
    await Promise.all([
      db().select({ count: count() }).from(agentRuns).where(ownedRuns),
      db()
        .select({ count: count() })
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.userId, args.userId),
            eq(agentSessions.orgId, args.orgId),
          ),
        ),
      db()
        .select({ count: count() })
        .from(agentRunCallbacks)
        .innerJoin(agentRuns, eq(agentRunCallbacks.runId, agentRuns.id))
        .where(ownedRuns),
      db()
        .select({ count: count() })
        .from(conversations)
        .innerJoin(agentRuns, eq(conversations.runId, agentRuns.id))
        .where(ownedRuns),
      db()
        .select({ count: count() })
        .from(checkpoints)
        .innerJoin(agentRuns, eq(checkpoints.runId, agentRuns.id))
        .where(ownedRuns),
    ]);

  return {
    runs: exactlyOneCount("Run", runRows),
    sessions: exactlyOneCount("Session", sessionRows),
    callbacks: exactlyOneCount("callback", callbackRows),
    conversations: exactlyOneCount("conversation", conversationRows),
    checkpoints: exactlyOneCount("checkpoint", checkpointRows),
  };
}

export async function readRunModelRuntimeRouteFixture(runId: string) {
  const [run] = await db()
    .select({
      modelProvider: agentRuns.modelProvider,
      selectedModel: agentRuns.selectedModel,
      modelRuntimeProvider: agentRuns.modelRuntimeProvider,
      modelRuntimeModel: agentRuns.modelRuntimeModel,
      vm0ModelKeyId: agentRuns.vm0ModelKeyId,
      modelKeyVendor: builtInModelKeys.vendor,
    })
    .from(agentRuns)
    .leftJoin(
      builtInModelKeys,
      eq(builtInModelKeys.id, agentRuns.vm0ModelKeyId),
    )
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run) {
    throw new Error("Expected one run runtime route");
  }
  return run;
}

/** Simulate historical or alternate managed-route metadata not constructible through current policy. */
export async function setRunModelRuntimeRouteFixture(args: {
  readonly runId: string;
  readonly modelRuntimeProvider: string | null;
  readonly modelRuntimeModel: string | null;
}): Promise<void> {
  const updated = await db()
    .update(agentRuns)
    .set({
      modelRuntimeProvider: args.modelRuntimeProvider,
      modelRuntimeModel: args.modelRuntimeModel,
    })
    .where(eq(agentRuns.id, args.runId))
    .returning({ id: agentRuns.id });
  if (updated.length !== 1) {
    throw new Error("Expected one run runtime route to update");
  }
}
