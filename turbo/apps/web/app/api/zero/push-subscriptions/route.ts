import { eq, and, lt, sql } from "drizzle-orm";
import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { pushSubscriptionsContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { pushSubscriptions } from "../../../../src/db/schema/push-subscription";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("zero:push-subscriptions");

const router = tsr.router(pushSubscriptionsContract, {
  register: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { endpoint, keys } = body;
    const userId = authCtx.userId;

    // Upsert: insert or update on endpoint conflict
    await globalThis.services.db
      .insert(pushSubscriptions)
      .values({
        userId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId,
          p256dh: keys.p256dh,
          auth: keys.auth,
          createdAt: sql`now()`,
        },
      });

    // Cleanup: delete stale subscriptions older than 7 days for this user
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await globalThis.services.db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, userId),
          lt(pushSubscriptions.createdAt, sevenDaysAgo),
        ),
      );

    log.debug("Push subscription registered", { userId, endpoint });

    return { status: 201 as const, body: { success: true as const } };
  },
});

const handler = createHandler(pushSubscriptionsContract, router, {
  routeName: "zero.push-subscriptions",
});

export { handler as POST };
