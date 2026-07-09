import webpush, { WebPushError } from "web-push";
import { eq } from "drizzle-orm";
import { pushSubscriptions } from "@vm0/db/schema/push-subscription";

import { logger } from "../../lib/log";
import { optionalEnv } from "../../lib/env";
import type { Db } from "../external/db";
import { settle } from "../utils";

const log = logger("api:push");
const PUSH_NOTIFICATION_TIMEOUT_MS = 10_000;
const PUSH_NOTIFICATION_CONCURRENCY = 5;

interface PushNotification {
  readonly title: string;
  readonly body: string;
  readonly url: string;
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const workerCount = Math.min(Math.max(1, limit), items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index];
        if (item === undefined) {
          return;
        }
        await fn(item);
      }
    }),
  );
}

async function sendPushToSubscription(args: {
  readonly db: Db;
  readonly subscription: typeof pushSubscriptions.$inferSelect;
  readonly payload: string;
}): Promise<void> {
  const result = await settle(
    webpush.sendNotification(
      {
        endpoint: args.subscription.endpoint,
        keys: {
          p256dh: args.subscription.p256dh,
          auth: args.subscription.auth,
        },
      },
      args.payload,
      { timeout: PUSH_NOTIFICATION_TIMEOUT_MS },
    ),
  );
  if (result.ok) {
    return;
  }

  const statusCode =
    result.error instanceof WebPushError ? result.error.statusCode : undefined;
  if (statusCode === 410 || statusCode === 404) {
    await args.db
      .delete(pushSubscriptions)
      .where(eq(pushSubscriptions.id, args.subscription.id));
    log.debug("Removed stale push subscription", {
      endpoint: args.subscription.endpoint,
    });
    return;
  }

  log.warn("Failed to send push notification", {
    endpoint: args.subscription.endpoint,
    error: result.error,
  });
}

/**
 * Send push notifications to all registered devices for a user.
 *
 * Missing VAPID keys are an intentional no-op, matching the legacy web route.
 */
export async function sendUserPushNotifications(args: {
  readonly db: Db;
  readonly userId: string;
  readonly notification: PushNotification;
}): Promise<void> {
  const publicKey = optionalEnv("VAPID_PUBLIC_KEY");
  const privateKey = optionalEnv("VAPID_PRIVATE_KEY");
  if (!publicKey || !privateKey) {
    return;
  }

  webpush.setVapidDetails("mailto:contact@vm0.ai", publicKey, privateKey);

  const subscriptions = await args.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, args.userId));
  if (subscriptions.length === 0) {
    return;
  }

  const payload = JSON.stringify(args.notification);
  await forEachWithConcurrency(
    subscriptions,
    PUSH_NOTIFICATION_CONCURRENCY,
    async (subscription) => {
      await sendPushToSubscription({
        db: args.db,
        subscription,
        payload,
      });
    },
  );
}
