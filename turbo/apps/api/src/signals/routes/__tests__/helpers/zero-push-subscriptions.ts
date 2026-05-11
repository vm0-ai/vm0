import { command } from "ccstate";
import { pushSubscriptions } from "@vm0/db/schema/push-subscription";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

export const clearPushSubscriptionsForUser$ = command(
  async ({ set }, userId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await db
      .delete(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    signal.throwIfAborted();
  },
);
