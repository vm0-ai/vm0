/**
 * Weekly product update pipeline.
 *
 * Trigger: the newsletter actually going out. Resend has no broadcast-level
 * event, so the first `email.sent` carrying an unseen `broadcast_id` claims the
 * work and every sibling event for that broadcast is dropped by the unique
 * index. A cron backstop re-scans recently sent broadcasts so a dropped webhook
 * cannot lose a whole week.
 *
 * Delivery: the message is rendered once from the broadcast and then inserted
 * into each member's chat thread as a plain `output.message`. No agent run is
 * started, so the fan-out costs members nothing.
 */
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import {
  weeklyProductUpdateDeliveries,
  weeklyProductUpdates,
} from "@okouai/db/schema/weekly-product-update";
import { command } from "ccstate";
import { and, asc, desc, eq, isNotNull, isNull, notExists } from "drizzle-orm";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import type { Tx } from "../../lib/db-types";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
} from "../external/realtime";
import { settle } from "../utils";
import { insertChatEvent } from "./chat-event.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { touchChatThreadLastMessageAt } from "./chat-event-shared.service";
import {
  getResendClient,
  resolveDefaultAgent,
} from "./zero-email-common.service";
import { resolveWeeklyProductUpdate } from "./weekly-product-update-message";
import { createAutomationChatThread } from "./workflow-user-automation-thread.service";

const L = logger("WeeklyProductUpdate");

const WEEKLY_PRODUCT_UPDATE_THREAD_TITLE = "Product updates";

/** Members processed per fan-out pass. */
const DELIVERY_BATCH_SIZE = 200;

/** How far back the backstop looks for a broadcast the webhook never claimed. */
const BACKSTOP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Broadcasts fetched per backstop pass. Resend returns newest first. */
const BACKSTOP_PAGE_SIZE = 20;

interface ClaimedBroadcast {
  readonly id: string;
  readonly broadcastId: string;
}

/**
 * Take ownership of a broadcast. Returns null when another event, another
 * instance, or an earlier backstop pass already claimed it.
 */
async function claimBroadcast(
  db: Db,
  broadcastId: string,
  currentTime: Date,
): Promise<ClaimedBroadcast | null> {
  const [claimed] = await db
    .insert(weeklyProductUpdates)
    .values({
      broadcastId,
      status: "pending",
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoNothing({ target: weeklyProductUpdates.broadcastId })
    .returning({
      id: weeklyProductUpdates.id,
      broadcastId: weeklyProductUpdates.broadcastId,
    });
  return claimed ?? null;
}

async function markSkipped(
  db: Db,
  id: string,
  reason: string,
  currentTime: Date,
): Promise<void> {
  await db
    .update(weeklyProductUpdates)
    .set({ status: "skipped", skipReason: reason, updatedAt: currentTime })
    .where(eq(weeklyProductUpdates.id, id));
}

/**
 * Fetch the claimed broadcast, decide whether it is a weekly product update,
 * and store the rendered message. A broadcast that points at an already
 * delivered post is skipped: marketing has resent the same campaign under a
 * fresh broadcast id before.
 */
const resolveClaimedBroadcast$ = command(
  async (
    { set },
    args: { readonly claimed: ClaimedBroadcast; readonly currentTime: Date },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const { claimed, currentTime } = args;

    const response = await getResendClient().broadcasts.get(
      claimed.broadcastId,
    );
    signal.throwIfAborted();
    if (response.error || !response.data) {
      await markSkipped(db, claimed.id, "broadcast-fetch-failed", currentTime);
      signal.throwIfAborted();
      L.error("weekly product update broadcast fetch failed", {
        broadcastId: claimed.broadcastId,
        error: response.error,
      });
      return;
    }

    const broadcast = response.data;
    const resolution = resolveWeeklyProductUpdate({
      status: broadcast.status,
      subject: broadcast.subject,
      html: broadcast.html,
    });
    if (resolution.kind === "skipped") {
      await markSkipped(db, claimed.id, resolution.reason, currentTime);
      signal.throwIfAborted();
      L.debug("weekly product update broadcast skipped", {
        broadcastId: claimed.broadcastId,
        reason: resolution.reason,
      });
      return;
    }

    const [alreadyDelivered] = await db
      .select({ id: weeklyProductUpdates.id })
      .from(weeklyProductUpdates)
      .where(
        and(
          eq(weeklyProductUpdates.status, "ready"),
          eq(weeklyProductUpdates.postSlug, resolution.content.postSlug),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (alreadyDelivered) {
      await markSkipped(db, claimed.id, "post-already-delivered", currentTime);
      signal.throwIfAborted();
      return;
    }

    await db
      .update(weeklyProductUpdates)
      .set({
        status: "ready",
        postSlug: resolution.content.postSlug,
        postUrl: resolution.content.postUrl,
        subject: broadcast.subject,
        message: resolution.content.message,
        broadcastSentAt: broadcast.sent_at
          ? new Date(broadcast.sent_at)
          : currentTime,
        updatedAt: currentTime,
      })
      .where(eq(weeklyProductUpdates.id, claimed.id));
    signal.throwIfAborted();
    L.debug("weekly product update ready", {
      broadcastId: claimed.broadcastId,
      postSlug: resolution.content.postSlug,
    });
  },
);

/**
 * Entry point for the shared Resend webhook. Every recipient of a broadcast
 * produces one `email.sent`, so all but the first are dropped by the claim.
 */
export const ingestWeeklyProductUpdateBroadcast$ = command(
  async (
    { set },
    broadcastId: string,
    signal: AbortSignal,
  ): Promise<"claimed" | "already-claimed"> => {
    const currentTime = nowDate();
    const claimed = await claimBroadcast(
      set(writeDb$),
      broadcastId,
      currentTime,
    );
    signal.throwIfAborted();
    if (!claimed) {
      return "already-claimed";
    }
    await set(resolveClaimedBroadcast$, { claimed, currentTime }, signal);
    signal.throwIfAborted();
    return "claimed";
  },
);

/**
 * Reuse the member's existing product-update thread so the weekly messages
 * accumulate in one place instead of creating a thread every week.
 */
async function existingUpdateThreadId(
  tx: Tx,
  userId: string,
): Promise<string | null> {
  const [previous] = await tx
    .select({ chatThreadId: weeklyProductUpdateDeliveries.chatThreadId })
    .from(weeklyProductUpdateDeliveries)
    .where(
      and(
        eq(weeklyProductUpdateDeliveries.userId, userId),
        isNotNull(weeklyProductUpdateDeliveries.chatThreadId),
      ),
    )
    .orderBy(desc(weeklyProductUpdateDeliveries.createdAt))
    .limit(1);
  return previous?.chatThreadId ?? null;
}

interface DeliveryCandidate {
  readonly orgId: string;
  readonly userId: string;
}

/**
 * Members who opted in and have not been processed for this update yet. A
 * member of several orgs matches once per org; the caller keeps the first.
 */
async function pendingCandidates(
  db: Db,
  weeklyProductUpdateId: string,
): Promise<readonly DeliveryCandidate[]> {
  const processed = db
    .select({ id: weeklyProductUpdateDeliveries.id })
    .from(weeklyProductUpdateDeliveries)
    .where(
      and(
        eq(
          weeklyProductUpdateDeliveries.weeklyProductUpdateId,
          weeklyProductUpdateId,
        ),
        eq(weeklyProductUpdateDeliveries.userId, orgMembersMetadata.userId),
      ),
    );
  return await db
    .select({
      orgId: orgMembersMetadata.orgId,
      userId: orgMembersMetadata.userId,
    })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.weeklyProductUpdateEnabled, true),
        notExists(processed),
      ),
    )
    .orderBy(asc(orgMembersMetadata.userId), asc(orgMembersMetadata.orgId))
    .limit(DELIVERY_BATCH_SIZE);
}

function firstCandidatePerUser(
  candidates: readonly DeliveryCandidate[],
): readonly DeliveryCandidate[] {
  const seen = new Set<string>();
  const unique: DeliveryCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.userId)) {
      continue;
    }
    seen.add(candidate.userId);
    unique.push(candidate);
  }
  return unique;
}

/**
 * Record that the update was processed for a member without delivering it.
 * Keeping the row is what lets the fan-out terminate instead of rescanning the
 * same members on every tick.
 */
async function recordSkippedDelivery(
  db: Db,
  weeklyProductUpdateId: string,
  candidate: DeliveryCandidate,
  currentTime: Date,
): Promise<void> {
  await db
    .insert(weeklyProductUpdateDeliveries)
    .values({
      weeklyProductUpdateId,
      orgId: candidate.orgId,
      userId: candidate.userId,
      chatThreadId: null,
      createdAt: currentTime,
    })
    .onConflictDoNothing();
}

async function deliverToMember(
  db: Db,
  args: {
    readonly weeklyProductUpdateId: string;
    readonly candidate: DeliveryCandidate;
    readonly message: string;
    readonly agentId: string;
    readonly currentTime: Date;
  },
): Promise<{ readonly chatThreadId: string; readonly seqId: number } | null> {
  const { candidate, currentTime } = args;
  return await db.transaction(async (tx) => {
    // Claim the member before creating anything, so a losing race leaves no
    // orphan thread behind.
    const [delivery] = await tx
      .insert(weeklyProductUpdateDeliveries)
      .values({
        weeklyProductUpdateId: args.weeklyProductUpdateId,
        orgId: candidate.orgId,
        userId: candidate.userId,
        chatThreadId: null,
        createdAt: currentTime,
      })
      .onConflictDoNothing()
      .returning({ id: weeklyProductUpdateDeliveries.id });
    if (!delivery) {
      return null;
    }

    const chatThreadId =
      (await existingUpdateThreadId(tx, candidate.userId)) ??
      (await createAutomationChatThread(tx, {
        userId: candidate.userId,
        orgId: candidate.orgId,
        agentId: args.agentId,
        title: WEEKLY_PRODUCT_UPDATE_THREAD_TITLE,
        currentTime,
      }));
    await tx
      .update(weeklyProductUpdateDeliveries)
      .set({ chatThreadId })
      .where(eq(weeklyProductUpdateDeliveries.id, delivery.id));

    // No run id: this is a product announcement, not agent output, so it
    // consumes no credits and starts no run.
    const inserted = await insertChatEvent(tx, {
      chatThreadId,
      eventType: "output.message",
      content: args.message,
      runId: null,
      createdAt: currentTime,
    });
    if (!inserted) {
      throw new Error("Failed to append the weekly product update message");
    }
    await touchChatThreadLastMessageAt(
      tx,
      chatThreadId,
      inserted.createdAt,
      inserted.id,
    );
    return { chatThreadId, seqId: inserted.seqId };
  });
}

interface FanOutResult {
  readonly delivered: number;
  readonly skipped: number;
  readonly completed: boolean;
}

const fanOutUpdate$ = command(
  async (
    { set },
    args: {
      readonly weeklyProductUpdateId: string;
      readonly message: string;
      readonly currentTime: Date;
    },
    signal: AbortSignal,
  ): Promise<FanOutResult> => {
    const db = set(writeDb$);
    const candidates = firstCandidatePerUser(
      await pendingCandidates(db, args.weeklyProductUpdateId),
    );
    signal.throwIfAborted();
    if (candidates.length === 0) {
      await db
        .update(weeklyProductUpdates)
        .set({ deliveredAt: args.currentTime, updatedAt: args.currentTime })
        .where(eq(weeklyProductUpdates.id, args.weeklyProductUpdateId));
      signal.throwIfAborted();
      return { delivered: 0, skipped: 0, completed: true };
    }

    let delivered = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      const enabled = isFeatureEnabled(
        FeatureSwitchKey.WeeklyProductUpdate,
        await loadUserFeatureSwitchContext(
          db,
          candidate.orgId,
          candidate.userId,
        ),
      );
      signal.throwIfAborted();
      const agentId = enabled
        ? await resolveDefaultAgent(db, candidate.orgId)
        : null;
      signal.throwIfAborted();
      if (!enabled || !agentId) {
        await recordSkippedDelivery(
          db,
          args.weeklyProductUpdateId,
          candidate,
          args.currentTime,
        );
        signal.throwIfAborted();
        skipped += 1;
        continue;
      }

      const result = await settle(
        deliverToMember(db, {
          weeklyProductUpdateId: args.weeklyProductUpdateId,
          candidate,
          message: args.message,
          agentId,
          currentTime: args.currentTime,
        }),
        signal,
      );
      if (!result.ok) {
        L.error("weekly product update delivery failed", {
          userId: candidate.userId,
          error: result.error,
        });
        continue;
      }
      if (!result.value) {
        skipped += 1;
        continue;
      }

      delivered += 1;
      await publishChatThreadMessageCreatedSafely(
        candidate.userId,
        result.value.chatThreadId,
        result.value.seqId,
      );
      signal.throwIfAborted();
      await publishThreadListChanged(candidate.userId);
      signal.throwIfAborted();
    }

    return { delivered, skipped, completed: false };
  },
);

/**
 * Backstop for a webhook Resend never delivered: claim any broadcast sent in
 * the lookback window that no `email.sent` event claimed.
 */
const claimUnseenBroadcasts$ = command(
  async ({ set }, currentTime: Date, signal: AbortSignal): Promise<number> => {
    const response = await getResendClient().broadcasts.list({
      limit: BACKSTOP_PAGE_SIZE,
    });
    signal.throwIfAborted();
    if (response.error || !response.data) {
      L.error("weekly product update backstop list failed", {
        error: response.error,
      });
      return 0;
    }

    const since = currentTime.getTime() - BACKSTOP_LOOKBACK_MS;
    let claimedCount = 0;
    for (const broadcast of response.data.data) {
      if (broadcast.status !== "sent" || !broadcast.sent_at) {
        continue;
      }
      if (new Date(broadcast.sent_at).getTime() < since) {
        continue;
      }
      const claimed = await claimBroadcast(
        set(writeDb$),
        broadcast.id,
        currentTime,
      );
      signal.throwIfAborted();
      if (!claimed) {
        continue;
      }
      claimedCount += 1;
      L.debug("weekly product update backstop claimed a broadcast", {
        broadcastId: broadcast.id,
      });
      await set(resolveClaimedBroadcast$, { claimed, currentTime }, signal);
      signal.throwIfAborted();
    }
    return claimedCount;
  },
);

interface WeeklyProductUpdateTickResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly skipped: number;
}

/**
 * One cron tick: run the backstop, then advance the fan-out of the oldest
 * ready update by a bounded batch.
 */
export const executeWeeklyProductUpdates$ = command(
  async (
    { set },
    args: { readonly currentTime: Date },
    signal: AbortSignal,
  ): Promise<WeeklyProductUpdateTickResult> => {
    const claimed = await set(claimUnseenBroadcasts$, args.currentTime, signal);
    signal.throwIfAborted();

    const db = set(writeDb$);
    const [pending] = await db
      .select({
        id: weeklyProductUpdates.id,
        message: weeklyProductUpdates.message,
      })
      .from(weeklyProductUpdates)
      .where(
        and(
          eq(weeklyProductUpdates.status, "ready"),
          isNull(weeklyProductUpdates.deliveredAt),
          isNotNull(weeklyProductUpdates.message),
        ),
      )
      .orderBy(asc(weeklyProductUpdates.broadcastSentAt))
      .limit(1);
    signal.throwIfAborted();
    if (!pending?.message) {
      return { claimed, delivered: 0, skipped: 0 };
    }

    const result = await set(
      fanOutUpdate$,
      {
        weeklyProductUpdateId: pending.id,
        message: pending.message,
        currentTime: args.currentTime,
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      claimed,
      delivered: result.delivered,
      skipped: result.skipped,
    };
  },
);
