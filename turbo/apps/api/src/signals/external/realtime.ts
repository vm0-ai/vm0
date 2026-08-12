import Ably from "ably";
import type {
  BrowserSessionChangedPayload,
  UserPreferenceChangedPayload,
} from "@vm0/api-contracts/contracts/realtime";
import type {
  ConnectorRuntimeTarget,
  PiExecutionMode,
  RunnerPreference,
} from "@vm0/api-contracts/contracts/runners";
import type { ZeroBuiltInGenerationRealtimeSubscription } from "@vm0/api-contracts/contracts/zero-built-in-generation";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import { waitUntil } from "../context/wait-until";
import { bestEffort, tapError } from "../utils";

const L = logger("Realtime");

const ablyClient = singleton((): Ably.Rest => {
  const client = new Ably.Rest({ key: env("ABLY_API_KEY"), queryTime: true });
  L.debug("Ably client initialised");
  return client;
});

function getUserChannelName(userId: string): string {
  return `user:${userId}`;
}

function getBuiltInGenerationEventName(generationId: string): string {
  return `built-in-generation:${generationId}`;
}

export async function createPlatformUserRealtimeToken(
  userId: string,
): Promise<Ably.TokenRequest> {
  const channelName = getUserChannelName(userId);
  const tokenRequest = await ablyClient().auth.createTokenRequest({
    capability: {
      [channelName]: ["subscribe"],
    },
    ttl: 60 * 60 * 1000,
    clientId: userId,
  });
  L.debug(`Generated platform realtime token for user:${userId}`);
  return tokenRequest;
}

export async function createBuiltInGenerationRealtimeSubscription(
  userId: string,
  generationId: string,
): Promise<ZeroBuiltInGenerationRealtimeSubscription> {
  return {
    channelName: getUserChannelName(userId),
    eventName: getBuiltInGenerationEventName(generationId),
    tokenRequest: await createPlatformUserRealtimeToken(userId),
  };
}

export async function createRunnerGroupRealtimeToken(
  group: string,
): Promise<Ably.TokenRequest> {
  const tokenRequest = await ablyClient().auth.createTokenRequest({
    capability: {
      [`runner-group:${group}`]: ["subscribe"],
    },
    ttl: 60 * 60 * 1000,
  });
  L.debug(`Generated runner group realtime token for ${group}`);
  return tokenRequest;
}

async function publishUserSignalNow(
  userIds: readonly string[],
  topic: string,
  payload: unknown,
): Promise<void> {
  const client = ablyClient();
  await Promise.all(
    userIds.map(async (userId) => {
      const channel = client.channels.get(getUserChannelName(userId));
      await channel.publish(topic, payload);
    }),
  );
  L.debug(`Published "${topic}" to ${userIds.length} user(s)`);
}

/**
 * Schedule a per-user invalidation/notification signal.
 *
 * Platform clients subscribe via the existing /api/okou/realtime/token
 * endpoint and receive events published by the API backend. Ably delivery is
 * best-effort: callers only wait for the background work to be registered, so
 * a delayed or rejected publish cannot fail the business operation.
 */
export function publishUserSignal(
  userIds: readonly string[],
  topic: string,
  payload: unknown = null,
): Promise<void> {
  waitUntil(bestEffort(publishUserSignalNow(userIds, topic, payload)));
  return Promise.resolve();
}

export async function publishUserPreferenceChangedForUserSafely(
  userId: string,
  kinds: UserPreferenceChangedPayload["kinds"],
): Promise<void> {
  await publishUserSignal([userId], "userPreferenceChanged", {
    kinds,
  } satisfies UserPreferenceChangedPayload);
}

/**
 * Fire the user-level "thread list shape changed" signal. The sidebar
 * subscribes to this topic and reloads the full list on any delivery —
 * payload is intentionally empty because the server is authoritative and
 * the client already has a cheap list endpoint to re-fetch.
 */
export async function publishThreadListChanged(userId: string): Promise<void> {
  await publishUserSignal([userId], "threadListChanged");
}

export async function publishThreadListChangedSafely(
  userId: string,
): Promise<void> {
  await publishThreadListChanged(userId);
}

/**
 * Notify an open chat thread that server-owned detail fields changed without a
 * request from that client. The client re-fetches the authoritative detail.
 */
export async function publishChatThreadDetailChangedSafely(
  userId: string,
  threadId: string,
): Promise<void> {
  await publishUserSignal([userId], `chatThreadDetailChanged:${threadId}`);
}

/**
 * Notify the chat message background sync that a new row was appended. It
 * refreshes IndexedDB and forwards newly fetched rows into visible threads, so
 * derived UI state (e.g. the composer's folded goal state) updates live.
 *
 * `syncThroughSeqId` is an optional watermark for the last row appended by the
 * publishing mutation. Clients that have already cached that sequence can
 * skip a delayed duplicate notification. Omit it when the batch boundary is
 * not known; payload-less events retain the unconditional catch-up behavior.
 *
 * Best-effort: a failed publish must not fail the mutation that triggered it.
 */
export async function publishChatThreadMessageCreatedSafely(
  userId: string,
  threadId: string,
  syncThroughSeqId?: number,
): Promise<void> {
  await publishUserSignal(
    [userId],
    `chatThreadMessageCreated:${threadId}`,
    syncThroughSeqId === undefined ? null : { syncThroughSeqId },
  );
}

/**
 * Notify a chat thread's UI that its linked automation set changed (created,
 * deleted, enabled, or disabled). The chat-thread header automation menu
 * subscribes to this topic and refetches its thread-scoped list.
 *
 * Best-effort: a failed publish must not fail the automation mutation that
 * triggers it. Payload is intentionally empty — the client re-fetches the
 * authoritative list on any delivery.
 */
export async function publishChatThreadAutomationsChangedSafely(
  userId: string,
  threadId: string,
): Promise<void> {
  await publishUserSignal([userId], `chatThreadAutomationsChanged:${threadId}`);
}

/**
 * Notify the user's chat threads that their connector permission grants
 * changed (allowed or denied from any client: chat permission card,
 * permission-allow page, or settings dialog). Chat threads subscribe to this
 * topic and invalidate all rendered permission cards at once — grants are few
 * and re-fetching them is cheap, so a single user-level signal beats
 * per-permission topics. Payload is intentionally empty.
 *
 * Best-effort: a failed publish must not fail the grant mutation that
 * triggers it.
 */
export async function publishConnectorPermissionUpdatedSafely(
  userId: string,
): Promise<void> {
  await publishUserSignal([userId], "connectorPermissionUpdated");
}

/**
 * Notify the user's open chat surfaces that one managed browser changed
 * lifecycle state. The thread-scoped payload lets each card registry reload
 * only the matching shared signals.
 *
 * Best-effort: a failed publish must not fail browser resume or reclamation.
 */
export async function publishBrowserSessionChangedSafely(
  userId: string,
  browser: {
    readonly threadId: string;
  },
): Promise<void> {
  const payload: BrowserSessionChangedPayload = browser;
  await publishUserSignal([userId], "browserSessionChanged", payload);
}

/**
 * Notify a chat thread's UI that its visible workflow set changed. The slash
 * workflow composer subscribes to this topic and refetches the authoritative
 * agent-scoped workflow list.
 *
 * Best-effort: a failed publish must not fail the workflow mutation that
 * triggers it.
 */
export async function publishChatThreadWorkflowsChangedSafely(
  userId: string,
  threadId: string,
): Promise<void> {
  await publishUserSignal([userId], `chatThreadWorkflowsChanged:${threadId}`);
}

export async function publishBuiltInGenerationChanged(
  userId: string,
  generationId: string,
  payload: unknown,
): Promise<void> {
  await publishUserSignal(
    [userId],
    getBuiltInGenerationEventName(generationId),
    payload,
  );
}

/** Publish an org-scoped signal for events shared by organization members. */
export async function publishOrgSignal(
  orgId: string,
  topic: string,
  payload: unknown = null,
): Promise<void> {
  const client = ablyClient();
  const channel = client.channels.get(`org:${orgId}`);
  await channel.publish(topic, payload);
  L.debug(`Published "${topic}" to org:${orgId}`);
}

export type RunnerCancellationMode = "cooperative" | "hard";

/**
 * Notify a runner-group channel that a run should halt. The runner subscribes
 * to its group's channel and applies the requested cancellation mode.
 */
export async function publishCancelToRunnerGroup(
  group: string,
  runId: string,
  mode: RunnerCancellationMode,
): Promise<void> {
  const client = ablyClient();
  const channel = client.channels.get(`runner-group:${group}`);
  await channel.publish("cancel", { runId, mode });
  L.debug(`Published ${mode} cancel ${runId} to runner-group:${group}`);
}

export async function publishConnectorRuntimeSyncToRunnerGroup(
  group: string,
  runId: string,
  target: ConnectorRuntimeTarget,
): Promise<void> {
  const channel = ablyClient().channels.get(`runner-group:${group}`);
  await channel.publish("connector-runtime-sync", { runId, target });
  L.debug(
    `Published connector runtime sync ${runId}/${target.kind} to runner-group:${group}`,
  );
}

export async function publishActiveInputToRunnerGroup(
  group: string,
  runId: string,
): Promise<void> {
  const channel = ablyClient().channels.get(`runner-group:${group}`);
  await channel.publish("active-input", { runId });
  L.debug(`Published active input ${runId} to runner-group:${group}`);
}

/** Wake the Pi standby runtime after the complete pending tool batch commits. */
async function publishPiHandoffToRunnerGroup(
  group: string,
  runId: string,
): Promise<void> {
  const channel = ablyClient().channels.get(`runner-group:${group}`);
  await channel.publish("pi-handoff", { runId });
  L.debug(`Published Pi handoff ${runId} to runner-group:${group}`);
}

export async function publishPiHandoffToRunnerGroupSafely(
  group: string,
  runId: string,
): Promise<void> {
  await tapError(publishPiHandoffToRunnerGroup(group, runId), (error) => {
    L.warn("Failed to publish Pi handoff", { group, runId, error });
  });
}

/** Release a prewarmed Pi Sandbox after the API has settled the run. */
export async function publishPiStandbyReleaseToRunnerGroupSafely(
  group: string,
  runId: string,
): Promise<void> {
  await tapError(
    (async () => {
      const channel = ablyClient().channels.get(`runner-group:${group}`);
      await channel.publish("pi-standby-release", { runId });
      L.debug(`Published Pi standby release ${runId} to runner-group:${group}`);
    })(),
    (error) => {
      L.warn("Failed to publish Pi standby release", { group, runId, error });
    },
  );
}

export async function publishRunnerJobNotification(args: {
  readonly group: string;
  readonly runId: string;
  readonly profile: string;
  readonly piExecutionMode?: PiExecutionMode;
  readonly runnerPreference: RunnerPreference;
  readonly metadata?: {
    /** Raw key required for runner-local reuse matching; it stays on the internal runner-group channel. */
    readonly reuseKey: string | null;
    readonly cliAgentSessionId: string | null;
    readonly historyGenerationRunId: string | undefined;
  };
}): Promise<boolean> {
  const published = await tapError(
    (async () => {
      const channel = ablyClient().channels.get(`runner-group:${args.group}`);
      await channel.publish("job", {
        runId: args.runId,
        profile: args.profile,
        ...(args.piExecutionMode
          ? { piExecutionMode: args.piExecutionMode }
          : {}),
        ...(args.metadata?.reuseKey
          ? { reuseKey: args.metadata.reuseKey }
          : {}),
        ...(args.metadata?.cliAgentSessionId
          ? { cliAgentSessionId: args.metadata.cliAgentSessionId }
          : {}),
        ...(args.metadata?.historyGenerationRunId
          ? { historyGenerationRunId: args.metadata.historyGenerationRunId }
          : {}),
        runnerPreference: args.runnerPreference,
      });
      L.debug(
        `Published job ${args.runId} to runner-group:${args.group} (broadcast)`,
      );
      return true;
    })(),
    (error) => {
      L.warn("Failed to publish runner job notification", {
        group: args.group,
        runId: args.runId,
        error,
      });
    },
  );
  return published ?? false;
}
