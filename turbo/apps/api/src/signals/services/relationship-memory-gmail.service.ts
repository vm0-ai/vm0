import { command } from "ccstate";
import { z } from "zod";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
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

import { logger } from "../../lib/log";
import { generateText, isLlmConfigured } from "../external/openrouter";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import { safeJsonParse, settle } from "../utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

const RELATIONSHIP_MEMORY_EXTRACTION_MODEL = "google/gemini-3.5-flash";

const log = logger("api:relationship-memory-gmail");
const MAX_JOBS_PER_DRAIN = 20;
const MAX_SOURCE_QUOTE_LENGTH = 320;
const RETRY_DELAY_MS = 5 * 60 * 1000;

interface GmailRelationshipMessageBase {
  readonly mailboxEmail: string;
  readonly historyId: string;
  readonly messageId: string;
  readonly threadId: string | null;
  readonly from: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string | null;
}

interface GmailRelationshipMessage extends GmailRelationshipMessageBase {
  readonly bodyText: string | null;
}

interface PersistedGmailRelationshipMessage extends GmailRelationshipMessageBase {
  readonly bodyExcerpt: string | null;
}

type RelationshipMemoryMessage =
  | GmailRelationshipMessage
  | PersistedGmailRelationshipMessage;

interface ParsedEmailAddress {
  readonly displayName: string;
  readonly email: string;
  readonly domain: string;
}

interface RelationshipTarget {
  readonly type: "person" | "organization";
  readonly identityKey: string;
  readonly displayName: string;
  readonly primaryEmail: string | null;
  readonly domain: string | null;
  readonly relationshipType: string;
  readonly fallbackSummary: string;
}

const extractionItemSchema = z.object({
  kind: z.enum(["key_fact", "preference", "open_loop"]),
  text: z.string().min(1).max(500),
  sourceQuote: z.string().min(1).max(MAX_SOURCE_QUOTE_LENGTH),
  confidence: z.number().int().min(0).max(100).default(80),
});

const extractionSchema = z.object({
  summary: z.string().min(1).max(900).nullable().default(null),
  relationshipType: z.string().min(1).max(80).nullable().default(null),
  items: z.array(extractionItemSchema).max(8).default([]),
});

type RelationshipExtraction = z.infer<typeof extractionSchema>;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength).trim();
}

function parseEmailAddress(value: string | null): ParsedEmailAddress | null {
  if (!value) {
    return null;
  }
  const emailMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const emailValue = emailMatch?.[0];
  if (!emailValue) {
    return null;
  }
  const email = normalizeEmail(emailValue);

  const domain = email.split("@")[1];
  if (!domain) {
    return null;
  }

  const rawName = value
    .replace(emailValue, "")
    .replace(/[<>"()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const localPart = email.split("@")[0] ?? email;
  const displayName =
    rawName.length > 0
      ? rawName
      : localPart
          .split(/[._-]+/)
          .filter(Boolean)
          .map((part) => {
            return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
          })
          .join(" ");

  return {
    displayName: displayName || email,
    email,
    domain: normalizeDomain(domain),
  };
}

function isSystemSender(address: ParsedEmailAddress): boolean {
  const localPart = address.email.split("@")[0] ?? "";
  return /^(no-?reply|do-?not-?reply|notifications?|newsletter|mailer|support|noreply)$/i.test(
    localPart,
  );
}

function displayNameFromDomain(domain: string): string {
  const base = domain.split(".")[0] ?? domain;
  return `${base.slice(0, 1).toUpperCase()}${base.slice(1)}`;
}

function excerptFromMessage(message: RelationshipMemoryMessage): string {
  const text =
    "bodyExcerpt" in message
      ? message.bodyExcerpt?.replace(/\s+/g, " ").trim()
      : message.bodyText?.replace(/\s+/g, " ").trim();
  if (text) {
    return truncate(text, MAX_SOURCE_QUOTE_LENGTH);
  }
  return truncate(
    message.subject ?? "Gmail interaction",
    MAX_SOURCE_QUOTE_LENGTH,
  );
}

function relationshipTargets(
  message: GmailRelationshipMessageBase,
): readonly RelationshipTarget[] {
  const sender = parseEmailAddress(message.from);
  if (!sender || isSystemSender(sender)) {
    return [];
  }

  const subject = message.subject?.trim() || "a Gmail thread";
  const personSummary = `${sender.displayName} emailed about ${subject}.`;
  const organizationName = displayNameFromDomain(sender.domain);

  return [
    {
      type: "person",
      identityKey: `person:${sender.email}`,
      displayName: sender.displayName,
      primaryEmail: sender.email,
      domain: sender.domain,
      relationshipType: "External contact",
      fallbackSummary: personSummary,
    },
    {
      type: "organization",
      identityKey: `organization:${sender.domain}`,
      displayName: organizationName,
      primaryEmail: null,
      domain: sender.domain,
      relationshipType: "Organization",
      fallbackSummary: `${organizationName} is represented in recent Gmail conversations about ${subject}.`,
    },
  ];
}

async function relationshipMemoryFeatureEnabled(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const context = await loadUserFeatureSwitchContext(db, orgId, userId);
  return isFeatureEnabled(FeatureSwitchKey.RelationshipMemory, context);
}

function gmailRefreshDedupeKey(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly messageId: string;
}): string {
  return [
    args.orgId,
    args.userId,
    "gmail",
    "gmail_relationship_refresh",
    args.messageId,
  ].join(":");
}

export async function enqueueGmailRelationshipRefreshJob(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly message: GmailRelationshipMessage;
    readonly priority?: number;
    readonly reason?: "gmail_webhook" | "gmail_backfill";
  },
): Promise<boolean> {
  if (
    !(await relationshipMemoryFeatureEnabled(db, args.orgId, args.userId)) ||
    relationshipTargets(args.message).length === 0
  ) {
    return false;
  }

  const currentTime = nowDate();
  const gmailMessage: PersistedGmailRelationshipMessage = {
    mailboxEmail: args.message.mailboxEmail,
    historyId: args.message.historyId,
    messageId: args.message.messageId,
    threadId: args.message.threadId,
    from: args.message.from,
    to: args.message.to,
    cc: args.message.cc,
    subject: args.message.subject,
    bodyExcerpt: excerptFromMessage(args.message),
  };
  const payload: RelationshipSyncJobPayload = {
    connectorId: args.connectorId,
    gmailThreadId: args.message.threadId ?? undefined,
    gmailMessageIds: [args.message.messageId],
    historyId: args.message.historyId,
    gmailMessage,
    reason: args.reason ?? "gmail_webhook",
  };

  await db
    .insert(relationshipSyncJobs)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      kind: "gmail_relationship_refresh",
      provider: "gmail",
      status: "pending",
      priority: args.priority ?? 0,
      dedupeKey: gmailRefreshDedupeKey({
        orgId: args.orgId,
        userId: args.userId,
        messageId: args.message.messageId,
      }),
      payload,
      runAfterAt: currentTime,
      attempts: 0,
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: relationshipSyncJobs.dedupeKey,
      set: {
        status: "pending",
        payload,
        priority: args.priority ?? 0,
        runAfterAt: currentTime,
        lockedAt: null,
        lastError: null,
        updatedAt: currentTime,
      },
    });

  await db
    .insert(relationshipMemorySettings)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      provider: "gmail",
      enabled: true,
      bootstrapStatus: "pending",
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [
        relationshipMemorySettings.orgId,
        relationshipMemorySettings.userId,
        relationshipMemorySettings.provider,
      ],
      set: {
        enabled: true,
        updatedAt: currentTime,
      },
    });

  return true;
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
    return { summary: null, relationshipType: null, items: [] };
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
          "Every item must be directly supported by the email and include a short sourceQuote.",
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
              from: args.message.from,
              to: args.message.to,
              cc: args.message.cc,
              subject: args.message.subject,
              bodyExcerpt: excerptFromMessage(args.message),
            },
            outputSchema: {
              summary: "string|null",
              relationshipType: "string|null",
              items:
                "Array<{ kind: 'key_fact'|'preference'|'open_loop', text: string, sourceQuote: string, confidence: 0-100 }>",
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
    return { summary: null, relationshipType: null, items: [] };
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
  readonly sourceQuote: string;
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
      quote: truncate(args.sourceQuote, MAX_SOURCE_QUOTE_LENGTH),
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
      subject: args.message.subject,
      snippet: excerptFromMessage(args.message),
      occurredAt: args.occurredAt,
      metadata: {
        direction: "received",
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

async function processGmailRelationshipRefreshJob(
  db: Db,
  job: {
    readonly orgId: string;
    readonly userId: string;
    readonly payload: RelationshipSyncJobPayload;
  },
): Promise<number> {
  const message = job.payload.gmailMessage;
  if (!message) {
    return 0;
  }

  if (!(await relationshipMemoryFeatureEnabled(db, job.orgId, job.userId))) {
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
      : { summary: null, relationshipType: null, items: [] };
    if (!extractionResult.ok) {
      log.warn("Relationship memory extraction failed", {
        messageId: message.messageId,
        error:
          extractionResult.error instanceof Error
            ? extractionResult.error.message
            : String(extractionResult.error),
      });
    }

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
        sourceQuote: item.sourceQuote,
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
          ? processGmailRelationshipRefreshJob(db, job)
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
