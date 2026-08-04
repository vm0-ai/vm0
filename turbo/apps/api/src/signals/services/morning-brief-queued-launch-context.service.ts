import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatMorningBriefContext } from "@vm0/db/schema/chat-morning-brief-context";
import { morningBriefDeliveries } from "@vm0/db/schema/morning-brief";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import {
  buildMorningBriefAppendSystemPrompt,
  buildMorningBriefRunPrompt,
} from "./morning-brief-run-prompt";

export interface MorningBriefQueuedLaunchMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly deliveryId: string;
  readonly userInfoExtras?: never;
}

interface MorningBriefLaunchContextRow {
  readonly deliveryId: string;
  readonly timezone: string | null;
  readonly triggeredAt: Date | null;
  readonly briefDate: string;
  readonly inputKey: string | null;
  readonly outputKey: string | null;
}

function requiredMorningBriefLaunchContext(
  row: MorningBriefLaunchContextRow | undefined,
) {
  if (
    !row ||
    row.timezone === null ||
    row.triggeredAt === null ||
    row.inputKey === null ||
    row.outputKey === null
  ) {
    return null;
  }
  return {
    ...row,
    timezone: row.timezone,
    triggeredAt: row.triggeredAt,
    inputKey: row.inputKey,
    outputKey: row.outputKey,
  };
}

async function loadMorningBriefLaunchContext(
  db: Db,
  args: {
    readonly eventId: string;
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
  },
) {
  const [row] = await db
    .select({
      deliveryId: chatMorningBriefContext.deliveryId,
      timezone: chatMorningBriefContext.timezone,
      triggeredAt: chatMorningBriefContext.triggeredAt,
      briefDate: morningBriefDeliveries.briefDate,
      inputKey: morningBriefDeliveries.inputKey,
      outputKey: morningBriefDeliveries.outputKey,
    })
    .from(chatEvents)
    .innerJoin(
      chatMorningBriefContext,
      and(
        eq(chatMorningBriefContext.id, chatEvents.contextId),
        eq(chatMorningBriefContext.chatThreadId, chatEvents.chatThreadId),
      ),
    )
    .innerJoin(
      morningBriefDeliveries,
      and(
        eq(morningBriefDeliveries.id, chatMorningBriefContext.deliveryId),
        eq(morningBriefDeliveries.orgId, args.orgId),
        eq(morningBriefDeliveries.userId, args.userId),
      ),
    )
    .where(
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        eq(chatEvents.contextType, "morning_brief"),
        eq(chatEvents.triggerSource, "workflow-schedule"),
      ),
    )
    .limit(1);
  return requiredMorningBriefLaunchContext(row);
}

export async function loadMorningBriefQueuedLaunchMaterial(
  db: Db,
  args: {
    readonly eventId: string;
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly resolveSignedUrls: (keys: {
      readonly inputKey: string;
      readonly outputKey: string;
    }) => Promise<{
      readonly inputUrl: string;
      readonly outputUrl: string;
    }>;
  },
): Promise<MorningBriefQueuedLaunchMaterial | null> {
  const context = await loadMorningBriefLaunchContext(db, args);
  if (!context) {
    return null;
  }
  const { inputUrl, outputUrl } = await args.resolveSignedUrls({
    inputKey: context.inputKey,
    outputKey: context.outputKey,
  });
  return {
    prompt: buildMorningBriefRunPrompt({
      briefDate: context.briefDate,
      timezone: context.timezone,
      deliveryId: context.deliveryId,
      triggeredAt: context.triggeredAt,
      inputUrl,
      outputUrl,
    }),
    appendSystemPrompt: buildMorningBriefAppendSystemPrompt({
      briefDate: context.briefDate,
      timezone: context.timezone,
      inputUrl,
      outputUrl,
    }),
    deliveryId: context.deliveryId,
  };
}
