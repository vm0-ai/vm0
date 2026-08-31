import Ably, { type CapabilityOp } from "ably";
import type {
  BrowserSessionChangedPayload,
  UserPreferenceChangedPayload,
} from "@okouai/api-contracts/contracts/realtime";
import type {
  ConnectorRuntimeTarget,
  RunnerPreference,
} from "@okouai/api-contracts/contracts/runners";
import type { BuiltInGenerationRealtimeSubscription } from "@okouai/api-contracts/contracts/built-in-generation";

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

function getOrgChannelName(orgId: string): string {
  return `org:${orgId}`;
}

function getUserOrgChannelName(userId: string, orgId: string): string {
  return `user-org:${userId}:${orgId}`;
}

function getBuiltInGenerationEventName(generationId: string): string {
  return `built-in-generation:${generationId}`;
}

async function createPlatformUserRealtimeToken(
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

export async function createPlatformRealtimeToken(
  userId: string,
  orgId: string | undefined,
): Promise<Ably.TokenRequest> {
  const capability: Record<string, CapabilityOp[]> = {
    [getUserChannelName(userId)]: ["subscribe"],
  };
  if (orgId !== undefined) {
    capability[getOrgChannelName(orgId)] = ["subscribe"];
    capability[getUserOrgChannelName(userId, orgId)] = ["subscribe"];
  }
  const tokenRequest = await ablyClient().auth.createTokenRequest({
    capability,
    ttl: 60 * 60 * 1000,
    clientId: userId,
  });
  L.debug(
    `Generated platform realtime token for user:${userId}${orgId === undefined ? "" : `/org:${orgId}`}`,
  );
  return tokenRequest;
}

export async function createBuiltInGenerationRealtimeSubscription(
  userId: string,
  generationId: string,
): Promise<BuiltInGenerationRealtimeSubscription> {
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

async function publishChatDatabaseSignalNow(
  target: { readonly userId: string; readonly orgId: string },
  topic: string,
  payload: unknown,
): Promise<void> {
  // Version-migration fallback: already-loaded App clients can keep the
  // pre-SharedWorker user-channel subscription for up to two days. Remove the
  // duplicate publish after the replacement App is live and the client-version
  // floor excludes pre-#30272 builds; follow-up #30334.
  const channelNames = [
    getUserOrgChannelName(target.userId, target.orgId),
    getUserChannelName(target.userId),
  ];
  const client = ablyClient();
  await Promise.all(
    channelNames.map(async (channelName) => {
      await client.channels.get(channelName).publish(topic, payload);
    }),
  );
  L.debug(`Published "${topic}" to ${channelNames.join(", ")}`);
}

function publishChatDatabaseSignal(
  target: { readonly userId: string; readonly orgId: string },
  topic: string,
  payload: unknown = null,
): Promise<void> {
  waitUntil(bestEffort(publishChatDatabaseSignalNow(target, topic, payload)));
  return Promise.resolve();
}

/**
 * Schedule a per-user invalidation/notification signal.
 *
 * Platform clients subscribe via the existing /api/realtime/token
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
 * Fire the per-user-org "thread list shape changed" signal. The SharedWorker
 * consumes this topic to invalidate its local thread-event view; the App then
 * reloads derived thread and indicator state. The payload is intentionally
 * empty because the server is authoritative.
 */
export async function publishThreadListChanged(target: {
  readonly userId: string;
  readonly orgId: string;
}): Promise<void> {
  await publishChatDatabaseSignal(target, "threadListChanged");
}

export async function publishThreadListChangedSafely(target: {
  readonly userId: string;
  readonly orgId: string;
}): Promise<void> {
  await publishThreadListChanged(target);
}

/**
 * Notify the owner that a runner published a reusable presentation template.
 * The catalog is server-owned, so every open client re-fetches it instead of
 * trying to reconstruct the new entry from the notification payload.
 */
export async function publishPresentationTemplatesChangedForUserSafely(
  userId: string,
): Promise<void> {
  await publishUserSignal([userId], "presentationTemplatesChanged");
}

export function publishPresentationTemplatesChangedForOrgSafely(
  orgId: string,
): Promise<void> {
  waitUntil(
    bestEffort(publishOrgSignal(orgId, "presentationTemplatesChanged")),
  );
  return Promise.resolve();
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
export async function publishChatThreadMessageCreatedSafely(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly threadId: string;
  readonly syncThroughSeqId?: number;
}): Promise<void> {
  await publishChatDatabaseSignal(
    args,
    `chatThreadMessageCreated:${args.threadId}`,
    args.syncThroughSeqId === undefined
      ? null
      : { syncThroughSeqId: args.syncThroughSeqId },
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
  const channel = client.channels.get(getOrgChannelName(orgId));
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

/** Publish an available runner job to the matching runner group. */
export async function publishRunnerJobNotification(args: {
  readonly group: string;
  readonly runId: string;
  readonly profile: string;
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
