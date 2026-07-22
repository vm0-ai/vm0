import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { slackChatThreadRoutes } from "@vm0/db/schema/slack-chat-thread-route";
import { and, eq, notExists, type SQL, type SQLWrapper } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

export async function canonicalSlackWebVisibilityEnabled(
  db: ReadonlyDb,
  args: { readonly orgId: string | undefined; readonly userId: string },
): Promise<boolean> {
  if (!args.orgId) {
    return false;
  }
  return isFeatureEnabled(
    FeatureSwitchKey.CanonicalSlackWebVisibility,
    await loadUserFeatureSwitchContext(db, args.orgId, args.userId),
  );
}

export function excludeCanonicalSlackChatThreads(
  db: Pick<ReadonlyDb, "select">,
  threadId: SQLWrapper,
): SQL {
  return notExists(
    db
      .select({ id: slackChatThreadRoutes.id })
      .from(slackChatThreadRoutes)
      .where(
        and(
          eq(slackChatThreadRoutes.backend, "canonical"),
          eq(slackChatThreadRoutes.chatThreadId, threadId),
        ),
      ),
  );
}

export async function hiddenCanonicalSlackChatThreadIds(
  db: ReadonlyDb,
  userId: string,
): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ chatThreadId: slackChatThreadRoutes.chatThreadId })
    .from(slackChatThreadRoutes)
    .where(
      and(
        eq(slackChatThreadRoutes.userId, userId),
        eq(slackChatThreadRoutes.backend, "canonical"),
      ),
    );
  return new Set(
    rows.flatMap((row) => {
      return row.chatThreadId ? [row.chatThreadId] : [];
    }),
  );
}

export async function isChatThreadVisibleInWeb(
  db: ReadonlyDb,
  args: {
    readonly threadId: string;
    readonly userId: string;
    readonly canonicalSlackVisible: boolean;
  },
): Promise<boolean> {
  if (args.canonicalSlackVisible) {
    return true;
  }
  const [route] = await db
    .select({ id: slackChatThreadRoutes.id })
    .from(slackChatThreadRoutes)
    .where(
      and(
        eq(slackChatThreadRoutes.userId, args.userId),
        eq(slackChatThreadRoutes.backend, "canonical"),
        eq(slackChatThreadRoutes.chatThreadId, args.threadId),
      ),
    )
    .limit(1);
  return route === undefined;
}
