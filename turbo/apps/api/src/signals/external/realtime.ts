import Ably from "ably";
import type { RemoteAgentRealtimeSubscription } from "@vm0/api-contracts/contracts/zero-remote-agent";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";

const L = logger("Realtime");

const ablyClient = singleton((): Ably.Rest => {
  const client = new Ably.Rest({ key: env("ABLY_API_KEY"), queryTime: true });
  L.debug("Ably client initialised");
  return client;
});

function getUserChannelName(userId: string): string {
  return `user:${userId}`;
}

function getRemoteAgentDeviceChannelName(deviceCodeId: string): string {
  return `remote-agent-device:${deviceCodeId}`;
}

function getRemoteAgentHostChannelName(hostId: string): string {
  return `remote-agent-host:${hostId}`;
}

const REMOTE_AGENT_DEVICE_APPROVED_EVENT = "approved";
const REMOTE_AGENT_HOST_JOB_EVENT = "job";
const REMOTE_AGENT_HOSTS_CHANGED_EVENT = "remote-agent:hosts-changed";

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

export async function createRemoteAgentDeviceRealtimeSubscription(
  deviceCodeId: string,
): Promise<RemoteAgentRealtimeSubscription> {
  const channelName = getRemoteAgentDeviceChannelName(deviceCodeId);
  const tokenRequest = await ablyClient().auth.createTokenRequest({
    capability: {
      [channelName]: ["subscribe"],
    },
    ttl: 60 * 60 * 1000,
  });

  return {
    channelName,
    eventName: REMOTE_AGENT_DEVICE_APPROVED_EVENT,
    tokenRequest,
  };
}

export async function publishRemoteAgentDeviceApproved(
  deviceCodeId: string,
): Promise<void> {
  const channel = ablyClient().channels.get(
    getRemoteAgentDeviceChannelName(deviceCodeId),
  );
  await channel.publish(REMOTE_AGENT_DEVICE_APPROVED_EVENT, {
    status: "approved",
  });
  L.debug(`Published remote-agent device approval ${deviceCodeId}`);
}

export async function createRemoteAgentHostRealtimeSubscription(
  hostId: string,
): Promise<RemoteAgentRealtimeSubscription> {
  const channelName = getRemoteAgentHostChannelName(hostId);
  const tokenRequest = await ablyClient().auth.createTokenRequest({
    capability: {
      [channelName]: ["subscribe"],
    },
    ttl: 60 * 60 * 1000,
  });

  return {
    channelName,
    eventName: REMOTE_AGENT_HOST_JOB_EVENT,
    tokenRequest,
  };
}

export async function publishRemoteAgentHostJobAvailable(
  hostId: string,
  jobId: string,
): Promise<void> {
  const channel = ablyClient().channels.get(
    getRemoteAgentHostChannelName(hostId),
  );
  await channel.publish(REMOTE_AGENT_HOST_JOB_EVENT, { jobId });
  L.debug(`Published remote-agent job ${jobId} to host ${hostId}`);
}

export async function publishRemoteAgentHostsChanged(
  userId: string,
): Promise<void> {
  await publishUserSignal([userId], REMOTE_AGENT_HOSTS_CHANGED_EVENT);
}
