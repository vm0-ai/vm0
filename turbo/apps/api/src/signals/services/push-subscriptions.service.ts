import { command } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { pushSubscriptions } from "@okouai/db/schema/push-subscription";
import { and, eq, lt, sql } from "drizzle-orm";

import { now } from "../../lib/time";
import { writeDb$ } from "../external/db";

const STALE_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000;

interface RegisterPushSubscriptionArgs {
  readonly userId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly publicBrand: PublicBrand;
}

export const registerPushSubscription$ = command(
  async (
    { set },
    args: RegisterPushSubscriptionArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);

    await db
      .insert(pushSubscriptions)
      .values({
        userId: args.userId,
        endpoint: args.endpoint,
        p256dh: args.p256dh,
        auth: args.auth,
        publicBrand: args.publicBrand,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId: args.userId,
          p256dh: args.p256dh,
          auth: args.auth,
          publicBrand: args.publicBrand,
          createdAt: sql`now()`,
        },
      });
    signal.throwIfAborted();

    const staleCutoff = new Date(now() - STALE_CUTOFF_MS);
    await db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, args.userId),
          lt(pushSubscriptions.createdAt, staleCutoff),
        ),
      );
    signal.throwIfAborted();
  },
);
