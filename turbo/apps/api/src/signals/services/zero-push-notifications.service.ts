import webpush, { WebPushError } from "web-push";
import { eq } from "drizzle-orm";
import { pushSubscriptions } from "@vm0/db/schema/push-subscription";

import { logger } from "../../lib/log";
import { optionalEnv } from "../../lib/env";
import type { Db } from "../external/db";
import { settle } from "../utils";

const log = logger("api:push");

interface PushNotification {
  readonly title: string;
  readonly body: string;
  readonly url: string;
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
  await Promise.all(
    subscriptions.map(async (subscription) => {
      const result = await settle(
        webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: {
              p256dh: subscription.p256dh,
              auth: subscription.auth,
            },
          },
          payload,
        ),
      );
      if (result.ok) {
        return;
      }

      const statusCode =
        result.error instanceof WebPushError
          ? result.error.statusCode
          : undefined;
      if (statusCode === 410 || statusCode === 404) {
        await args.db
          .delete(pushSubscriptions)
          .where(eq(pushSubscriptions.id, subscription.id));
        log.debug("Removed stale push subscription", {
          endpoint: subscription.endpoint,
        });
        return;
      }

      log.warn("Failed to send push notification", {
        endpoint: subscription.endpoint,
        error: result.error,
      });
    }),
  );
}
