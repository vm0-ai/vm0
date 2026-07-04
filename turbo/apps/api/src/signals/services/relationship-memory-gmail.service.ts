import { command } from "ccstate";
import { z } from "zod";
import {
  relationshipEntities,
  relationshipInteractions,
  relationshipItems,
  relationshipItemSources,
  relationshipMemorySettings,
  relationshipStates,
  relationshipSyncJobs,
  type RelationshipItemKind,
  type RelationshipSyncJobPayload,
} from "@vm0/db/schema/relationship-memory";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { htmlToText } from "html-to-text";

import { logger } from "../../lib/log";
import { generateText, isLlmConfigured } from "../external/openrouter";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { safeJsonParse, settle } from "../utils";
import {
  fetchGmailMessageContextById,
  messageIsInbound,
  resolveGmailAccess,
} from "./gmail-workflow-event.service";
import {
  relationshipMemoryFeatureEnabled,
  relationshipTargets,
  type GmailRelationshipMessage,
  type RelationshipTarget,
} from "./relationship-memory-gmail-queue.service";

const RELATIONSHIP_MEMORY_EXTRACTION_MODEL = "google/gemini-3.5-flash";

const log = logger("api:relationship-memory-gmail");
const MAX_JOBS_PER_DRAIN = 20;
const MAX_TRANSIENT_BODY_EXCERPT_LENGTH = 320;
const MAX_INTERACTION_SUMMARY_LENGTH = 280;
const RETRY_DELAY_MS = 5 * 60 * 1000;

type RelationshipMemoryMessage = GmailRelationshipMessage;

const extractionItemSchema = z.object({
  kind: z.enum(["key_fact", "preference", "open_loop"]),
  text: z.string().min(1).max(500),
  confidence: z.number().int().min(0).max(100).default(80),
});

const extractionSchema = z.object({
  summary: z.string().min(1).max(900).nullable().default(null),
  relationshipType: z.string().min(1).max(80).nullable().default(null),
  interactionSummary: z
    .string()
    .min(1)
    .max(MAX_INTERACTION_SUMMARY_LENGTH)
    .nullable()
    .default(null),
  items: z.array(extractionItemSchema).max(8).default([]),
});

type RelationshipExtraction = z.infer<typeof extractionSchema>;

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength).trim();
}

function cleanEmailBodyText(value: string): string {
  return htmlToText(value, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
    ],
  })
    .replace(/\s+/g, " ")
    .trim();
}

function transientBodyExcerptFromMessage(
  message: RelationshipMemoryMessage,
): string | null {
  if (!message.bodyText) {
    return null;
  }
  const text = cleanEmailBodyText(message.bodyText);
  return text ? truncate(text, MAX_TRANSIENT_BODY_EXCERPT_LENGTH) : null;
}

function fallbackInteractionSummary(
  target: RelationshipTarget,
  message: RelationshipMemoryMessage,
): string {
  return truncate(
    message.direction === "sent"
      ? `The user sent ${target.displayName} a Gmail message.`
      : `${target.displayName} sent a Gmail message.`,
    MAX_INTERACTION_SUMMARY_LENGTH,
  );
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  return safeJsonParse(candidate);
}

async function extractRelationshipMemory(args: {
  readonly target: RelationshipTarget;
  readonly existingSummary: string | null;
  readonly message: RelationshipMemoryMessage;
}): Promise<RelationshipExtraction> {
  if (!isLlmConfigured()) {
    return {
      summary: null,
      relationshipType: null,
      interactionSummary: null,
      items: [],
    };
  }

  const generated = await generateText(
    RELATIONSHIP_MEMORY_EXTRACTION_MODEL,
    [
      {
        role: "system",
        content: [
          "Extract relationship memory from Gmail evidence.",
          "Return strict JSON only.",
          "Allowed item kinds: key_fact, preference, open_loop.",
          "Paraphrase; do not return direct quotes, raw email text, or HTML.",
          "Use gmail.direction: sent means the user sent the message; received means the user received it.",
          "Every item must be directly supported by the email.",
          "Do not invent facts. If there is no durable memory, return an empty items array.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            relationship: {
              type: args.target.type,
              displayName: args.target.displayName,
              email: args.target.primaryEmail,
              domain: args.target.domain,
              existingSummary: args.existingSummary,
            },
            gmail: {
              direction: args.message.direction ?? "unknown",
              from: args.message.from,
              to: args.message.to,
              cc: args.message.cc,
              subject: args.message.subject,
              bodyExcerpt: transientBodyExcerptFromMessage(args.message),
            },
            outputSchema: {
              summary: "string|null",
              relationshipType: "string|null",
              interactionSummary:
                "string|null; one short user-facing sentence that paraphrases the interaction",
              items:
                "Array<{ kind: 'key_fact'|'preference'|'open_loop', text: string, confidence: 0-100 }>",
            },
          },
          null,
          2,
        ),
      },
    ],
    900,
  );

  if (!generated) {
    return {
      summary: null,
      relationshipType: null,
      interactionSummary: null,
      items: [],
    };
  }

  const parsed = extractionSchema.safeParse(extractJsonObject(generated));
  if (!parsed.success) {
    throw new Error("Relationship memory extraction returned invalid JSON");
  }
  return parsed.data;
}

async function loadExistingState(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly identityKey: string;
}) {
  const [row] = await args.db
    .select({
      stateId: relationshipStates.id,
      entityId: relationshipEntities.id,
      summary: relationshipStates.summary,
      relationshipType: relationshipStates.relationshipType,
    })
    .from(relationshipEntities)
    .innerJoin(
      relationshipStates,
      eq(relationshipStates.entityId, relationshipEntities.id),
    )
    .where(
      and(
        eq(relationshipEntities.orgId, args.orgId),
        eq(relationshipEntities.userId, args.userId),
        eq(relationshipEntities.identityKey, args.identityKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function upsertRelationshipState(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly target: RelationshipTarget;
  readonly extraction: RelationshipExtraction;
  readonly existing: Awaited<ReturnType<typeof loadExistingState>>;
  readonly occurredAt: Date;
}) {
  const currentTime = nowDate();
  const [entity] = await args.db
    .insert(relationshipEntities)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      type: args.target.type,
      identityKey: args.target.identityKey,
      displayName: args.target.displayName,
      primaryEmail: args.target.primaryEmail,
      domain: args.target.domain,
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [
        relationshipEntities.orgId,
        relationshipEntities.userId,
        relationshipEntities.identityKey,
      ],
      set: {
        displayName: args.target.displayName,
        primaryEmail: args.target.primaryEmail,
        domain: args.target.domain,
        updatedAt: currentTime,
      },
    })
    .returning({ id: relationshipEntities.id });

  const entityId = entity?.id ?? args.existing?.entityId;
  if (!entityId) {
    throw new Error("Failed to upsert relationship entity");
  }

  const summary =
    args.extraction.summary ??
    args.existing?.summary ??
    args.target.fallbackSummary;
  const relationshipType =
    args.extraction.relationshipType ??
    args.existing?.relationshipType ??
    args.target.relationshipType;

  const [state] = await args.db
    .insert(relationshipStates)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      entityId,
      relationshipType,
      status: "active",
      summary,
      lastInteractionAt: args.occurredAt,
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [
        relationshipStates.orgId,
        relationshipStates.userId,
        relationshipStates.entityId,
      ],
      set: {
        relationshipType,
        status: "active",
        summary,
        lastInteractionAt: args.occurredAt,
        updatedAt: currentTime,
      },
    })
    .returning({ id: relationshipStates.id });

  const stateId = state?.id ?? args.existing?.stateId;
  if (!stateId) {
    throw new Error("Failed to upsert relationship state");
  }

  return { entityId, stateId };
}

async function upsertRelationshipItem(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly stateId: string;
  readonly kind: RelationshipItemKind;
  readonly text: string;
  readonly confidence: number;
  readonly message: RelationshipMemoryMessage;
  readonly occurredAt: Date;
}) {
  const currentTime = nowDate();
  const [existing] = await args.db
    .select({ id: relationshipItems.id })
    .from(relationshipItems)
    .where(
      and(
        eq(relationshipItems.orgId, args.orgId),
        eq(relationshipItems.userId, args.userId),
        eq(relationshipItems.relationshipStateId, args.stateId),
        eq(relationshipItems.kind, args.kind),
        eq(relationshipItems.text, args.text),
        isNull(relationshipItems.archivedAt),
      ),
    )
    .limit(1);

  const itemId =
    existing?.id ??
    (
      await args.db
        .insert(relationshipItems)
        .values({
          orgId: args.orgId,
          userId: args.userId,
          relationshipStateId: args.stateId,
          kind: args.kind,
          text: args.text,
          confidence: args.confidence,
          createdAt: currentTime,
          updatedAt: currentTime,
          lastSeenAt: currentTime,
        })
        .returning({ id: relationshipItems.id })
    )[0]?.id;

  if (!itemId) {
    throw new Error("Failed to upsert relationship item");
  }

  if (existing) {
    await args.db
      .update(relationshipItems)
      .set({
        confidence: args.confidence,
        updatedAt: currentTime,
        lastSeenAt: currentTime,
      })
      .where(eq(relationshipItems.id, itemId));
  }

  await args.db
    .insert(relationshipItemSources)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      relationshipItemId: itemId,
      provider: "gmail",
      externalId: [
        args.message.messageId,
        args.kind,
        args.text.toLowerCase().slice(0, 80),
      ].join(":"),
      threadId: args.message.threadId,
      messageId: args.message.messageId,
      quote: null,
      occurredAt: args.occurredAt,
      createdAt: currentTime,
    })
    .onConflictDoNothing();
}

async function recordInteraction(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly stateId: string;
  readonly entityId: string;
  readonly connectorId: string | null;
  readonly message: RelationshipMemoryMessage;
  readonly snippet: string;
  readonly occurredAt: Date;
}) {
  await args.db
    .insert(relationshipInteractions)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      relationshipStateId: args.stateId,
      entityId: args.entityId,
      provider: "gmail",
      connectorId: args.connectorId,
      externalId: args.message.messageId,
      threadId: args.message.threadId,
      messageId: args.message.messageId,
      subject: null,
      snippet: args.snippet,
      occurredAt: args.occurredAt,
      metadata: {
        direction: args.message.direction ?? "unknown",
        participants: [
          args.message.from,
          ...args.message.to,
          ...args.message.cc,
        ].filter((value): value is string => {
          return Boolean(value);
        }),
      },
      createdAt: nowDate(),
    })
    .onConflictDoNothing();
}

async function loadMessageForRelationshipExtraction(
  db: Db,
  job: {
    readonly orgId: string;
    readonly userId: string;
    readonly payload: RelationshipSyncJobPayload;
  },
  signal: AbortSignal,
): Promise<GmailRelationshipMessage | null> {
  const message = job.payload.gmailMessage;
  if (!message) {
    return null;
  }

  const access = await resolveGmailAccess({
    db,
    orgId: job.orgId,
    userId: job.userId,
    connectorId: job.payload.connectorId,
    signal,
  });
  signal.throwIfAborted();
  if (access.kind !== "ok") {
    throw new Error(access.message);
  }

  const context = await fetchGmailMessageContextById({
    accessToken: access.access.accessToken,
    messageId: message.messageId,
    threadId: message.threadId,
    labelIds: [],
    historyId: message.historyId,
    signal,
  });
  signal.throwIfAborted();
  if (!context) {
    return null;
  }
  const direction =
    message.direction ?? (messageIsInbound(context) ? "received" : null);
  if (!direction) {
    return null;
  }

  return {
    mailboxEmail: message.mailboxEmail,
    historyId: message.historyId,
    messageId: context.messageId,
    threadId: context.threadId,
    direction,
    from: context.from ?? message.from,
    to: context.to.length > 0 ? context.to : message.to,
    cc: context.cc.length > 0 ? context.cc : message.cc,
    subject: context.subject ?? message.subject,
    bodyText: context.bodyText,
  };
}

async function processGmailRelationshipRefreshJob(
  db: Db,
  job: {
    readonly orgId: string;
    readonly userId: string;
    readonly payload: RelationshipSyncJobPayload;
  },
  signal: AbortSignal,
): Promise<number> {
  if (!(await relationshipMemoryFeatureEnabled(db, job.orgId, job.userId))) {
    return 0;
  }

  const message = await loadMessageForRelationshipExtraction(db, job, signal);
  if (!message) {
    return 0;
  }

  const targets = relationshipTargets(message);
  const occurredAt = nowDate();
  let updated = 0;

  for (const target of targets) {
    const existing = await loadExistingState({
      db,
      orgId: job.orgId,
      userId: job.userId,
      identityKey: target.identityKey,
    });
    const extractionResult = await settle(
      extractRelationshipMemory({
        target,
        existingSummary: existing?.summary ?? null,
        message,
      }),
    );
    const extraction = extractionResult.ok
      ? extractionResult.value
      : {
          summary: null,
          relationshipType: null,
          interactionSummary: null,
          items: [],
        };
    if (!extractionResult.ok) {
      log.warn("Relationship memory extraction failed", {
        messageId: message.messageId,
        error:
          extractionResult.error instanceof Error
            ? extractionResult.error.message
            : String(extractionResult.error),
      });
    }
    const interactionSummary =
      extraction.interactionSummary ??
      fallbackInteractionSummary(target, message);

    const state = await upsertRelationshipState({
      db,
      orgId: job.orgId,
      userId: job.userId,
      target,
      extraction,
      existing,
      occurredAt,
    });
    await recordInteraction({
      db,
      orgId: job.orgId,
      userId: job.userId,
      stateId: state.stateId,
      entityId: state.entityId,
      connectorId: job.payload.connectorId ?? null,
      message,
      snippet: interactionSummary,
      occurredAt,
    });

    for (const item of extraction.items) {
      await upsertRelationshipItem({
        db,
        orgId: job.orgId,
        userId: job.userId,
        stateId: state.stateId,
        kind: item.kind,
        text: item.text,
        confidence: item.confidence,
        message,
        occurredAt,
      });
    }
    updated += 1;
  }

  await db
    .insert(relationshipMemorySettings)
    .values({
      orgId: job.orgId,
      userId: job.userId,
      provider: "gmail",
      enabled: true,
      bootstrapStatus: "done",
      lastSyncAt: nowDate(),
      createdAt: nowDate(),
      updatedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: [
        relationshipMemorySettings.orgId,
        relationshipMemorySettings.userId,
        relationshipMemorySettings.provider,
      ],
      set: {
        enabled: true,
        bootstrapStatus: "done",
        lastSyncAt: nowDate(),
        lastError: null,
        updatedAt: nowDate(),
      },
    });

  return updated;
}

export const drainRelationshipSyncJobs$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const pendingJobs = await db
      .select({
        id: relationshipSyncJobs.id,
        orgId: relationshipSyncJobs.orgId,
        userId: relationshipSyncJobs.userId,
        kind: relationshipSyncJobs.kind,
        payload: relationshipSyncJobs.payload,
        attempts: relationshipSyncJobs.attempts,
      })
      .from(relationshipSyncJobs)
      .where(
        and(
          eq(relationshipSyncJobs.status, "pending"),
          lte(relationshipSyncJobs.runAfterAt, currentTime),
        ),
      )
      .orderBy(
        asc(relationshipSyncJobs.priority),
        asc(relationshipSyncJobs.runAfterAt),
      )
      .limit(MAX_JOBS_PER_DRAIN);
    signal.throwIfAborted();

    let processed = 0;
    let failed = 0;
    let relationshipsUpdated = 0;

    for (const job of pendingJobs) {
      await db
        .update(relationshipSyncJobs)
        .set({
          status: "running",
          lockedAt: nowDate(),
          attempts: sql`${relationshipSyncJobs.attempts} + 1`,
          updatedAt: nowDate(),
        })
        .where(eq(relationshipSyncJobs.id, job.id));
      signal.throwIfAborted();

      const result = await settle(
        job.kind === "gmail_relationship_refresh"
          ? processGmailRelationshipRefreshJob(db, job, signal)
          : Promise.resolve(0),
      );
      signal.throwIfAborted();

      if (result.ok) {
        processed += 1;
        relationshipsUpdated += result.value;
        await db
          .update(relationshipSyncJobs)
          .set({
            status: "done",
            lockedAt: null,
            lastError: null,
            updatedAt: nowDate(),
          })
          .where(eq(relationshipSyncJobs.id, job.id));
        signal.throwIfAborted();
        continue;
      }

      failed += 1;
      const message =
        result.error instanceof Error
          ? result.error.message
          : String(result.error);
      const retry = job.attempts + 1 < 3;
      await db
        .update(relationshipSyncJobs)
        .set({
          status: retry ? "pending" : "failed",
          lockedAt: null,
          runAfterAt: retry
            ? new Date(nowDate().getTime() + RETRY_DELAY_MS)
            : nowDate(),
          lastError: message,
          updatedAt: nowDate(),
        })
        .where(eq(relationshipSyncJobs.id, job.id));
      signal.throwIfAborted();
    }

    return {
      success: true as const,
      processed,
      failed,
      relationshipsUpdated,
    };
  },
);
