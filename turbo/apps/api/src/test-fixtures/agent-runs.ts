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
import {
  agentComposes,
  agentComposeVersions,
} from "@okouai/db/schema/agent-compose";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { blobs } from "@okouai/db/schema/blob";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import { conversations } from "@okouai/db/schema/conversation";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { storages } from "@okouai/db/schema/storage";
import { and, count, eq, inArray } from "drizzle-orm";

import { db } from "../lib/db";
import { badRequestMessage, notFound } from "../lib/error";
import { now } from "../lib/time";
import {
  createAgentRun$,
  type CreateAgentRunArgs,
} from "../signals/services/agent-run-create.service";
import { agentRunList } from "../signals/services/agent-runs.service";
import {
  isCompressedSessionHistoryBlobEncoding,
  normalizeSessionHistoryBlobEncoding,
} from "../signals/services/session-history-blobs";
import { projectLegacyWritebackArtifacts } from "../signals/services/storage-legacy-projection.service";

const store = createStore();

type LegacyDirectRunResolver = NonNullable<
  CreateAgentRunArgs["testOnlyResolveLegacyDirectRunCompose"]
>;
type LegacyDirectRunResolution = Awaited<ReturnType<LegacyDirectRunResolver>>;
type LegacyDirectRunResolverArgs = Parameters<LegacyDirectRunResolver>[0];
type LegacyResolvedCompose = Extract<
  LegacyDirectRunResolution,
  { readonly composeId: string }
>;

const MISSING_AGENT_CONFIGURATION_MESSAGE =
  "Agent configuration is unavailable. Edit the agent, or ask its owner to edit it, then try again.";

async function measureLegacyDirectResolution<T>(
  timing: LegacyDirectRunResolverArgs["timing"],
  actionType:
    | "api_dispatch_resolve_compose_lookup_agent"
    | "api_dispatch_resolve_compose_lookup_session_snapshot"
    | "api_dispatch_resolve_compose_resolve_session_history",
  work: () => Promise<T> | T,
): Promise<T> {
  return timing
    ? await timing.measure(actionType, "nested", work)
    : await Promise.resolve(work());
}

function resumeSessionFromLegacySnapshot(snapshot: {
  readonly runId: string;
  readonly cliAgentSessionId: string;
  readonly cliAgentSessionHistory: string | null;
  readonly cliAgentSessionHistoryHash: string | null;
  readonly sessionHistoryBlobEncoding: string | null;
}): LegacyResolvedCompose["resumeSession"] {
  const hash = snapshot.cliAgentSessionHistoryHash;
  let encoding;
  if (snapshot.sessionHistoryBlobEncoding !== null) {
    const parsedEncoding = normalizeSessionHistoryBlobEncoding(
      snapshot.sessionHistoryBlobEncoding,
    );
    if (isCompressedSessionHistoryBlobEncoding(parsedEncoding)) {
      encoding = parsedEncoding;
    }
  }
  if (hash) {
    return {
      sessionId: snapshot.cliAgentSessionId,
      historyGenerationRunId: snapshot.runId,
      historyRef: {
        kind: "blob",
        hash,
        ...(encoding ? { encoding } : {}),
      },
    };
  }
  if (snapshot.cliAgentSessionHistory) {
    return {
      sessionId: snapshot.cliAgentSessionId,
      sessionHistory: snapshot.cliAgentSessionHistory,
    };
  }
  return undefined;
}

async function resolveLegacyDirectAgentRun(
  args: LegacyDirectRunResolverArgs,
  agentId: string,
): Promise<LegacyDirectRunResolution> {
  const [row] = await measureLegacyDirectResolution(
    args.timing,
    "api_dispatch_resolve_compose_lookup_agent",
    async () => {
      return await args.db
        .select({
          composeId: agentComposes.id,
          composeName: agentComposes.name,
          composeOrgId: agentComposes.orgId,
          composeUserId: agentComposes.userId,
          headVersionId: agentComposes.headVersionId,
          versionId: agentComposeVersions.id,
          versionContent: agentComposeVersions.content,
        })
        .from(agentComposes)
        .leftJoin(
          agentComposeVersions,
          eq(agentComposeVersions.id, agentComposes.headVersionId),
        )
        .where(eq(agentComposes.id, agentId))
        .limit(1);
    },
  );
  if (!row) {
    return notFound("Agent compose not found");
  }
  if (!row.headVersionId || !row.versionId) {
    return badRequestMessage(MISSING_AGENT_CONFIGURATION_MESSAGE);
  }
  return {
    composeId: row.composeId,
    composeUserId: row.composeUserId,
    agentName: row.composeName || undefined,
    orgId: row.composeOrgId,
    content: row.versionContent as LegacyResolvedCompose["content"],
    artifacts: [],
  };
}

async function loadLegacyDirectSessionSnapshot(
  args: LegacyDirectRunResolverArgs,
  sessionId: string,
) {
  return await measureLegacyDirectResolution(
    args.timing,
    "api_dispatch_resolve_compose_lookup_session_snapshot",
    async () => {
      return await args.db
        .select({
          session: {
            id: agentSessions.id,
            storageMounts: agentSessions.storageMounts,
          },
          compose: {
            id: agentComposes.id,
            name: agentComposes.name,
            orgId: agentComposes.orgId,
            userId: agentComposes.userId,
            headVersionId: agentComposes.headVersionId,
          },
          version: {
            id: agentComposeVersions.id,
            content: agentComposeVersions.content,
          },
          conversation: {
            id: conversations.id,
            runId: conversations.runId,
            cliAgentSessionId: conversations.cliAgentSessionId,
            cliAgentSessionHistory: conversations.cliAgentSessionHistory,
            cliAgentSessionHistoryHash:
              conversations.cliAgentSessionHistoryHash,
          },
          historyBlob: { hash: blobs.hash, encoding: blobs.encoding },
          previousRun: {
            id: agentRuns.id,
            vars: agentRuns.vars,
            modelProvider: agentRuns.modelProvider,
            modelRuntimeProvider: agentRuns.modelRuntimeProvider,
            modelRuntimeModel: agentRuns.modelRuntimeModel,
          },
        })
        .from(agentSessions)
        .leftJoin(
          agentComposes,
          eq(agentSessions.agentComposeId, agentComposes.id),
        )
        .leftJoin(
          agentComposeVersions,
          eq(agentComposeVersions.id, agentComposes.headVersionId),
        )
        .leftJoin(
          conversations,
          eq(agentSessions.conversationId, conversations.id),
        )
        .leftJoin(
          blobs,
          eq(conversations.cliAgentSessionHistoryHash, blobs.hash),
        )
        .leftJoin(agentRuns, eq(conversations.runId, agentRuns.id))
        .where(
          and(
            eq(agentSessions.id, sessionId),
            eq(agentSessions.userId, args.userId),
            eq(agentSessions.orgId, args.orgId),
          ),
        )
        .limit(1);
    },
  );
}

async function resolveLegacyDirectSessionRun(
  args: LegacyDirectRunResolverArgs,
  sessionId: string,
): Promise<LegacyDirectRunResolution> {
  const [snapshot] = await loadLegacyDirectSessionSnapshot(args, sessionId);
  if (!snapshot) {
    return notFound("Agent session not found");
  }
  if (!snapshot.compose) {
    return notFound("Agent compose not found");
  }
  if (!snapshot.compose.headVersionId || !snapshot.version) {
    return badRequestMessage(MISSING_AGENT_CONFIGURATION_MESSAGE);
  }
  if (snapshot.session.storageMounts === null) {
    throw new Error(
      `Agent session "${snapshot.session.id}" is missing canonical Storage mounts`,
    );
  }

  const conversation = snapshot.conversation;
  const resumeSession = conversation
    ? await measureLegacyDirectResolution(
        args.timing,
        "api_dispatch_resolve_compose_resolve_session_history",
        () => {
          return resumeSessionFromLegacySnapshot({
            ...conversation,
            sessionHistoryBlobEncoding: snapshot.historyBlob?.encoding ?? null,
          });
        },
      )
    : undefined;
  return {
    composeId: snapshot.compose.id,
    composeUserId: snapshot.compose.userId,
    agentName: snapshot.compose.name || undefined,
    orgId: snapshot.compose.orgId,
    content: snapshot.version.content as LegacyResolvedCompose["content"],
    artifacts: projectLegacyWritebackArtifacts(snapshot.session.storageMounts),
    persistedStorageMounts: snapshot.session.storageMounts,
    vars:
      (snapshot.previousRun?.vars as Record<string, string> | null) ??
      undefined,
    agentSessionId: snapshot.session.id,
    continuedFromAgentSessionId: snapshot.session.id,
    resumeSession,
    ...(snapshot.previousRun
      ? { resumeSessionModelRoute: snapshot.previousRun }
      : {}),
  };
}

const resolveLegacyDirectRunCompose: LegacyDirectRunResolver = async (args) => {
  if (args.body.sessionId) {
    return await resolveLegacyDirectSessionRun(args, args.body.sessionId);
  }
  return args.body.agentId
    ? await resolveLegacyDirectAgentRun(args, args.body.agentId)
    : badRequestMessage("Missing agentId or sessionId");
};

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
      testOnlyResolveLegacyDirectRunCompose: resolveLegacyDirectRunCompose,
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
