import Ably from "ably";

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
