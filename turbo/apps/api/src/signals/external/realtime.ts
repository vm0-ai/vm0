import Ably from "ably";
import type { LocalBrowserRealtimeSubscription } from "@vm0/api-contracts/contracts/zero-local-browser";
import type { LocalAgentRealtimeSubscription } from "@vm0/api-contracts/contracts/zero-local-agent";
import type { ZeroBuiltInGenerationRealtimeSubscription } from "@vm0/api-contracts/contracts/zero-built-in-generation";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import { safeAsync } from "../utils";

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

function getLocalAgentDeviceChannelName(deviceCodeId: string): string {
  return `local-agent-device:${deviceCodeId}`;
}

function getLocalAgentHostChannelName(hostId: string): string {
  return `local-agent-host:${hostId}`;
}

function getLocalBrowserDeviceChannelName(deviceCodeId: string): string {
  return `local-browser-device:${deviceCodeId}`;
}

function getLocalBrowserHostChannelName(hostId: string): string {
  return `local-browser-host:${hostId}`;
}

const LOCAL_AGENT_DEVICE_APPROVED_EVENT = "approved";
const LOCAL_AGENT_HOST_JOB_EVENT = "job";
const LOCAL_AGENT_HOSTS_CHANGED_EVENT = "local-agent:hosts-changed";
const LOCAL_BROWSER_DEVICE_APPROVED_EVENT = "approved";
const LOCAL_BROWSER_HOST_COMMAND_EVENT = "command";
const LOCAL_BROWSER_HOSTS_CHANGED_EVENT = "local-browser:hosts-changed";

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
 * Channel naming and payload shape mirror the existing apps/web helper
 * (apps/web/src/lib/infra/realtime/client.ts). Platform clients subscribe via
 * the existing /api/zero/realtime/token endpoint and receive events from
 * either backend during the rollout window.
 *
 * NOT best-effort: rejections from Ably propagate to the caller, matching
 * web's behaviour. Wave 2/3 mutation handlers should use this directly; if
 * a non-blocking publish becomes necessary for a future route, prefer
 * `safeAsync` from ../utils.
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
  await publishUserSignal([userId], `run:changed:${runId}`, payload).catch(
    (error: unknown) => {
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
 * Notify a runner-group channel that a run should halt. Mirrors web's
 * publishCancelNotification; the runner subscribes to its group's
 * channel and aborts the matching run on receipt.
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
): Promise<boolean> {
  const result = await safeAsync(async () => {
    const channel = ablyClient().channels.get(`runner-group:${group}`);
    await channel.publish("job", { runId, profile });
    L.debug(`Published job ${runId} to runner-group:${group}`);
  });
  if ("ok" in result) {
    return true;
  }
  L.warn("Failed to publish runner job notification", {
    group,
    runId,
    error: result.error,
  });
  return false;
}

export async function createLocalAgentDeviceRealtimeSubscription(
  deviceCodeId: string,
): Promise<LocalAgentRealtimeSubscription> {
  const channelName = getLocalAgentDeviceChannelName(deviceCodeId);
  const tokenRequest = await ablyClient().auth.createTokenRequest({
    capability: {
      [channelName]: ["subscribe"],
    },
    ttl: 60 * 60 * 1000,
  });

  return {
    channelName,
    eventName: LOCAL_AGENT_DEVICE_APPROVED_EVENT,
    tokenRequest,
  };
}

export async function publishLocalAgentDeviceApproved(
  deviceCodeId: string,
): Promise<void> {
  const channel = ablyClient().channels.get(
    getLocalAgentDeviceChannelName(deviceCodeId),
  );
  await channel.publish(LOCAL_AGENT_DEVICE_APPROVED_EVENT, {
    status: "approved",
  });
  L.debug(`Published local-agent device approval ${deviceCodeId}`);
}

export async function createLocalAgentHostRealtimeSubscription(
  hostId: string,
): Promise<LocalAgentRealtimeSubscription> {
  const channelName = getLocalAgentHostChannelName(hostId);
  const tokenRequest = await ablyClient().auth.createTokenRequest({
    capability: {
      [channelName]: ["subscribe"],
    },
    ttl: 60 * 60 * 1000,
  });

  return {
    channelName,
    eventName: LOCAL_AGENT_HOST_JOB_EVENT,
    tokenRequest,
  };
}

export async function publishLocalAgentHostJobAvailable(
  hostId: string,
  jobId: string,
): Promise<void> {
  const channel = ablyClient().channels.get(
    getLocalAgentHostChannelName(hostId),
  );
  await channel.publish(LOCAL_AGENT_HOST_JOB_EVENT, { jobId });
  L.debug(`Published local-agent job ${jobId} to host ${hostId}`);
}

export async function publishLocalAgentHostsChanged(
  userId: string,
): Promise<void> {
  await publishUserSignal([userId], LOCAL_AGENT_HOSTS_CHANGED_EVENT);
}

export async function createLocalBrowserDeviceRealtimeSubscription(
  deviceCodeId: string,
): Promise<LocalBrowserRealtimeSubscription> {
  const channelName = getLocalBrowserDeviceChannelName(deviceCodeId);
  const tokenRequest = await ablyClient().auth.createTokenRequest({
    capability: {
      [channelName]: ["subscribe"],
    },
    ttl: 60 * 60 * 1000,
  });

  return {
    channelName,
    eventName: LOCAL_BROWSER_DEVICE_APPROVED_EVENT,
    tokenRequest,
  };
}

export async function publishLocalBrowserDeviceApproved(
  deviceCodeId: string,
): Promise<void> {
  const channel = ablyClient().channels.get(
    getLocalBrowserDeviceChannelName(deviceCodeId),
  );
  await channel.publish(LOCAL_BROWSER_DEVICE_APPROVED_EVENT, {
    status: "approved",
  });
  L.debug(`Published local-browser device approval ${deviceCodeId}`);
}

export async function createLocalBrowserHostRealtimeSubscription(
  hostId: string,
): Promise<LocalBrowserRealtimeSubscription> {
  const channelName = getLocalBrowserHostChannelName(hostId);
  const tokenRequest = await ablyClient().auth.createTokenRequest({
    capability: {
      [channelName]: ["subscribe"],
    },
    ttl: 60 * 60 * 1000,
  });

  return {
    channelName,
    eventName: LOCAL_BROWSER_HOST_COMMAND_EVENT,
    tokenRequest,
  };
}

export async function publishLocalBrowserHostCommandAvailable(
  hostId: string,
  commandId: string,
): Promise<void> {
  const channel = ablyClient().channels.get(
    getLocalBrowserHostChannelName(hostId),
  );
  await channel.publish(LOCAL_BROWSER_HOST_COMMAND_EVENT, {
    commandId,
  });
  L.debug(`Published local-browser command ${commandId} for host ${hostId}`);
}

export async function publishLocalBrowserHostsChanged(
  userId: string,
): Promise<void> {
  await publishUserSignal([userId], LOCAL_BROWSER_HOSTS_CHANGED_EVENT);
}
