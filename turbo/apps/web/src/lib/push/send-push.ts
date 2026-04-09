import "server-only";
import webpush, { WebPushError } from "web-push";
import { eq } from "drizzle-orm";
import { env } from "../../env";
import { pushSubscriptions } from "../../db/schema/push-subscription";
import { logger } from "../shared/logger";

const log = logger("push");

interface PushNotification {
  title: string;
  body: string;
  url: string;
}

/**
 * Send push notifications to all of a user's registered devices.
 *
 * Missing VAPID keys → silent no-op.
 * 410 Gone responses auto-delete the stale subscription.
 */
export async function sendUserPushNotifications(
  userId: string,
  notification: PushNotification,
): Promise<void> {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = env();
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return;
  }

  webpush.setVapidDetails(
    "mailto:contact@vm0.ai",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY,
  );

  const subscriptions = await globalThis.services.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  if (subscriptions.length === 0) {
    return;
  }

  const payload = JSON.stringify(notification);

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
        );
      } catch (err: unknown) {
        const statusCode =
          err instanceof WebPushError ? err.statusCode : undefined;
        if (statusCode === 410 || statusCode === 404) {
          // Subscription expired or invalid — clean up
          await globalThis.services.db
            .delete(pushSubscriptions)
            .where(eq(pushSubscriptions.id, sub.id));
          log.debug("Removed stale push subscription", {
            endpoint: sub.endpoint,
          });
        } else {
          log.warn("Failed to send push notification", {
            endpoint: sub.endpoint,
            err,
          });
        }
      }
    }),
  );
}
