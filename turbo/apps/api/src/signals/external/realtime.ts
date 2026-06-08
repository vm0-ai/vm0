import Ably from "ably";
import type { ZeroBuiltInGenerationRealtimeSubscription } from "@vm0/api-contracts/contracts/zero-built-in-generation";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import { settle, tapError } from "../utils";

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

/**
 * Publish a per-user invalidation/notification signal.
 *
 * Platform clients subscribe via the existing /api/zero/realtime/token
 * endpoint and receive events published by the API backend.
 *
 * NOT best-effort: rejections from Ably propagate to the caller, matching
 * the original route behaviour. Mutation handlers should use this directly; if
 * a non-blocking publish becomes necessary for a future route, prefer
 * `settle` from ../utils.
 */
export async function publishUserSignal(
  userIds: readonly string[],
  topic: string,
  payload: unknown = null,
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

export async function publishRunChangedForUserSafely(
  userId: string,
  runId: string,
  payload: unknown = null,
): Promise<void> {
  await tapError(
    publishUserSignal([userId], `run:changed:${runId}`, payload),
    (error) => {
      L.warn("Failed to publish run changed signal", { runId, error });
    },
  );
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

/**
 * Notify a chat thread's UI that its linked schedule set changed (created,
 * deleted, enabled, or disabled). The chat-thread header schedule menu
 * subscribes to this topic and refetches its thread-scoped list.
 *
 * Best-effort: a failed publish must not fail the schedule mutation that
 * triggers it. Payload is intentionally empty — the client re-fetches the
 * authoritative list on any delivery.
 */
export async function publishChatThreadSchedulesChangedSafely(
  userId: string,
  threadId: string,
): Promise<void> {
  await tapError(
    publishUserSignal([userId], `chatThreadSchedulesChanged:${threadId}`),
    (error) => {
      L.warn("Failed to publish chat thread schedules changed signal", {
        threadId,
        error,
      });
    },
  );
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

/**
 * Publish an org-scoped signal. Used for events that any org member's UI
 * may want to see (e.g. queue:changed when a run cancels and a queued
 * run becomes eligible to dispatch).
 */
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

/**
 * Notify a runner-group channel that a run should halt. The runner subscribes
 * to its group's channel and aborts the matching run on receipt.
 */
export async function publishCancelToRunnerGroup(
  group: string,
  runId: string,
): Promise<void> {
  const client = ablyClient();
  const channel = client.channels.get(`runner-group:${group}`);
  await channel.publish("cancel", { runId });
  L.debug(`Published cancel ${runId} to runner-group:${group}`);
}

export async function publishRunnerJobNotification(
  group: string,
  runId: string,
  profile: string,
  targetRunnerId: string | null = null,
): Promise<boolean> {
  const result = await settle(
    (async () => {
      const channel = ablyClient().channels.get(`runner-group:${group}`);
      await channel.publish("job", {
        runId,
        profile,
        ...(targetRunnerId ? { targetRunnerId } : {}),
      });
      L.debug(
        `Published job ${runId} to runner-group:${group}` +
          (targetRunnerId ? ` (target: ${targetRunnerId})` : " (broadcast)"),
      );
    })(),
  );
  if (result.ok) {
    return true;
  }
  L.warn("Failed to publish runner job notification", {
    group,
    runId,
    error: result.error,
  });
  return false;
}
