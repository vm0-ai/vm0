import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";

import { strapiEntryPublishedEventConfigSchema } from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import {
  strapiIntegrations,
  strapiWebhookDeliveries,
  strapiWorkflowPendingEvents,
  zeroWorkflowStrapiAutomations,
} from "@vm0/db/schema/strapi-integration";
import {
  workflowUserAutomationThreads,
  zeroWorkflowAutomations,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import { safeJsonParse, settle } from "../utils";
import { workflowAutomationCanFire } from "./zero-workflow-automation-access.service";
import type { WorkflowQueueAdmissionTransaction } from "./workflow-chat-event-queue.service";
import {
  buildChatOnlyWorkflowAutomationCallbacks,
  runWorkflowAutomationNow$,
  type AutomationRow,
  type RunFailure,
  type RunWorkflowAutomationNowArgs,
  type RunWorkflowAutomationResult,
} from "./zero-workflow-automation-run.service";

const log = logger("api:strapi-workflow-event");

export const STRAPI_WEBHOOK_BODY_LIMIT_BYTES = 1_000_000;
const STRAPI_PUBLISH_QUIET_WINDOW_MS = 45_000;
const STRAPI_PENDING_RETRY_MS = 60_000;
const STRAPI_PENDING_MAX_ATTEMPTS = 5;
const STRAPI_PENDING_BATCH_SIZE = 25;

const strapiPublishEventSchema = z
  .object({
    event: z.literal("entry.publish"),
    createdAt: z.string().optional(),
    model: z.string().trim().min(1).max(255),
    uid: z.string().trim().min(1).max(255),
    entry: z
      .object({
        documentId: z.string().trim().min(1).max(255),
        locale: z.string().trim().min(1).max(64).nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

type StrapiPublishEvent = z.infer<typeof strapiPublishEventSchema>;
type StrapiIntegrationRow = typeof strapiIntegrations.$inferSelect;
type StrapiPendingRow = typeof strapiWorkflowPendingEvents.$inferSelect;
type StrapiWebhookTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

type DispatchStrapiWebhookResult =
  | {
      readonly kind: "ok";
      readonly webhookKind: "test" | "publish" | "ignored" | "duplicate";
      readonly queued: number;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "disabled" }
  | { readonly kind: "bad_request"; readonly message: string };

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bearerToken(authorization: string | null): string | null {
  if (!authorization) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

function hashesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

async function loadStrapiIntegration(
  db: Db,
  integrationId: string,
): Promise<StrapiIntegrationRow | null> {
  const [integration] = await db
    .select()
    .from(strapiIntegrations)
    .where(eq(strapiIntegrations.id, integrationId))
    .limit(1);
  return integration ?? null;
}

function eventTimestamp(event: StrapiPublishEvent): Date {
  if (event.createdAt) {
    const parsed = new Date(event.createdAt);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return nowDate();
}

function eventLocale(event: StrapiPublishEvent): string {
  return event.entry.locale ?? "default";
}

function pendingEventLockKey(args: {
  readonly automationId: string;
  readonly uid: string;
  readonly documentId: string;
}): string {
  return [args.automationId, args.uid, args.documentId].join(":");
}

async function enqueueOrRefreshStrapiPendingEvent(args: {
  readonly db: StrapiWebhookTransaction;
  readonly automation: AutomationRow;
  readonly integrationId: string;
  readonly event: StrapiPublishEvent;
  readonly signal: AbortSignal;
}): Promise<void> {
  const lockKey = pendingEventLockKey({
    automationId: args.automation.id,
    uid: args.event.uid,
    documentId: args.event.entry.documentId,
  });
  await args.db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
  args.signal.throwIfAborted();

  const [pending] = await args.db
    .select()
    .from(strapiWorkflowPendingEvents)
    .where(
      and(
        eq(strapiWorkflowPendingEvents.automationId, args.automation.id),
        eq(strapiWorkflowPendingEvents.uid, args.event.uid),
        eq(strapiWorkflowPendingEvents.documentId, args.event.entry.documentId),
        eq(strapiWorkflowPendingEvents.status, "pending"),
      ),
    )
    .limit(1);
  const currentTime = nowDate();
  const locale = eventLocale(args.event);
  const receivedEventAt = eventTimestamp(args.event);
  const runAfter = new Date(
    currentTime.getTime() + STRAPI_PUBLISH_QUIET_WINDOW_MS,
  );
  if (pending) {
    await args.db
      .update(strapiWorkflowPendingEvents)
      .set({
        model: args.event.model,
        locales: [...new Set([...pending.locales, locale])].sort(),
        latestEventAt: receivedEventAt,
        runAfter,
        revision: sql`${strapiWorkflowPendingEvents.revision} + 1`,
        lastError: null,
        updatedAt: currentTime,
      })
      .where(eq(strapiWorkflowPendingEvents.id, pending.id));
    return;
  }
  await args.db.insert(strapiWorkflowPendingEvents).values({
    automationId: args.automation.id,
    integrationId: args.integrationId,
    uid: args.event.uid,
    model: args.event.model,
    documentId: args.event.entry.documentId,
    locales: [locale],
    status: "pending",
    firstEventAt: receivedEventAt,
    latestEventAt: receivedEventAt,
    runAfter,
    createdAt: currentTime,
    updatedAt: currentTime,
  });
}

async function enqueueMatchingStrapiAutomations(args: {
  readonly db: StrapiWebhookTransaction;
  readonly integration: StrapiIntegrationRow;
  readonly event: StrapiPublishEvent;
  readonly signal: AbortSignal;
}): Promise<number> {
  const rows = await args.db
    .select({ automation: zeroWorkflowAutomations })
    .from(zeroWorkflowStrapiAutomations)
    .innerJoin(
      zeroWorkflowAutomations,
      eq(
        zeroWorkflowAutomations.id,
        zeroWorkflowStrapiAutomations.automationId,
      ),
    )
    .where(
      and(
        eq(zeroWorkflowStrapiAutomations.integrationId, args.integration.id),
        eq(zeroWorkflowAutomations.orgId, args.integration.orgId),
        eq(zeroWorkflowAutomations.eventType, "strapi-entry-published"),
        eq(zeroWorkflowAutomations.enabled, true),
      ),
    )
    .orderBy(asc(zeroWorkflowAutomations.id));
  args.signal.throwIfAborted();

  let queued = 0;
  for (const { automation } of rows) {
    const config = strapiEntryPublishedEventConfigSchema.safeParse(
      automation.eventConfig,
    );
    if (
      !config.success ||
      (config.data.contentTypeUid !== undefined &&
        config.data.contentTypeUid !== args.event.uid) ||
      (config.data.locale !== undefined &&
        config.data.locale !== eventLocale(args.event))
    ) {
      continue;
    }
    await enqueueOrRefreshStrapiPendingEvent({
      db: args.db,
      automation,
      integrationId: args.integration.id,
      event: args.event,
      signal: args.signal,
    });
    queued += 1;
  }
  return queued;
}

export const dispatchStrapiWebhook$ = command(
  async (
    { set },
    args: {
      readonly integrationId: string;
      readonly authorization: string | null;
      readonly eventHeader: string | null;
      readonly rawBody: string;
    },
    signal: AbortSignal,
  ): Promise<DispatchStrapiWebhookResult> => {
    const db = set(writeDb$);
    const integration = await loadStrapiIntegration(db, args.integrationId);
    signal.throwIfAborted();
    if (!integration) {
      return { kind: "not_found" };
    }
    if (
      !isFeatureEnabled(FeatureSwitchKey.StrapiIntegration, {
        orgId: integration.orgId,
      })
    ) {
      return { kind: "disabled" };
    }
    const token = bearerToken(args.authorization);
    if (!token || !hashesEqual(sha256Hex(token), integration.tokenHash)) {
      return { kind: "unauthorized" };
    }
    const payload = safeJsonParse(args.rawBody);
    if (payload === undefined) {
      return { kind: "bad_request", message: "Invalid Strapi webhook JSON" };
    }
    const payloadEvent =
      typeof payload === "object" &&
      payload !== null &&
      "event" in payload &&
      typeof payload.event === "string"
        ? payload.event
        : null;
    const eventName = payloadEvent ?? args.eventHeader;
    if (eventName === "trigger-test") {
      await db
        .update(strapiIntegrations)
        .set({ lastTestedAt: nowDate(), updatedAt: nowDate() })
        .where(eq(strapiIntegrations.id, integration.id));
      signal.throwIfAborted();
      return { kind: "ok", webhookKind: "test", queued: 0 };
    }
    if (eventName !== "entry.publish") {
      return { kind: "ok", webhookKind: "ignored", queued: 0 };
    }
    const parsed = strapiPublishEventSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        kind: "bad_request",
        message: "Invalid Strapi entry.publish payload",
      };
    }

    const result = await db.transaction(async (tx) => {
      const bodySha256 = sha256Hex(args.rawBody);
      const [delivery] = await tx
        .insert(strapiWebhookDeliveries)
        .values({
          integrationId: integration.id,
          bodySha256,
          event: parsed.data.event,
          receivedAt: nowDate(),
        })
        .onConflictDoNothing()
        .returning({ id: strapiWebhookDeliveries.id });
      signal.throwIfAborted();
      if (!delivery) {
        return {
          kind: "ok",
          webhookKind: "duplicate",
          queued: 0,
        } as const;
      }
      await tx
        .update(strapiIntegrations)
        .set({ lastReceivedAt: nowDate(), updatedAt: nowDate() })
        .where(eq(strapiIntegrations.id, integration.id));
      signal.throwIfAborted();
      const queued = await enqueueMatchingStrapiAutomations({
        db: tx,
        integration,
        event: parsed.data,
        signal,
      });
      return { kind: "ok", webhookKind: "publish", queued } as const;
    });
    signal.throwIfAborted();
    return result;
  },
);

function pendingColumns() {
  return {
    id: strapiWorkflowPendingEvents.id,
    automationId: strapiWorkflowPendingEvents.automationId,
    integrationId: strapiWorkflowPendingEvents.integrationId,
    uid: strapiWorkflowPendingEvents.uid,
    model: strapiWorkflowPendingEvents.model,
    documentId: strapiWorkflowPendingEvents.documentId,
    locales: strapiWorkflowPendingEvents.locales,
    status: strapiWorkflowPendingEvents.status,
    firstEventAt: strapiWorkflowPendingEvents.firstEventAt,
    latestEventAt: strapiWorkflowPendingEvents.latestEventAt,
    runAfter: strapiWorkflowPendingEvents.runAfter,
    attempts: strapiWorkflowPendingEvents.attempts,
    revision: strapiWorkflowPendingEvents.revision,
    lastError: strapiWorkflowPendingEvents.lastError,
    skipReason: strapiWorkflowPendingEvents.skipReason,
    processedAt: strapiWorkflowPendingEvents.processedAt,
    createdAt: strapiWorkflowPendingEvents.createdAt,
    updatedAt: strapiWorkflowPendingEvents.updatedAt,
  };
}

function pendingVersionCondition(pending: StrapiPendingRow) {
  return and(
    eq(strapiWorkflowPendingEvents.id, pending.id),
    eq(strapiWorkflowPendingEvents.status, "pending"),
    eq(strapiWorkflowPendingEvents.revision, pending.revision),
  );
}

async function skipPendingEvent(args: {
  readonly db: Db;
  readonly pending: StrapiPendingRow;
  readonly reason: string;
  readonly attempts?: number;
  readonly lastError?: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  await args.db.transaction(async (tx) => {
    const lockKey = pendingEventLockKey(args.pending);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
    args.signal.throwIfAborted();
    await tx
      .update(strapiWorkflowPendingEvents)
      .set({
        status: "skipped",
        attempts: args.attempts ?? args.pending.attempts,
        lastError: args.lastError ?? args.pending.lastError,
        skipReason: args.reason,
        processedAt: nowDate(),
        updatedAt: nowDate(),
      })
      .where(pendingVersionCondition(args.pending));
  });
  args.signal.throwIfAborted();
}

async function retryPendingEvent(args: {
  readonly db: Db;
  readonly pending: StrapiPendingRow;
  readonly message: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const nextAttempts = args.pending.attempts + 1;
  if (nextAttempts >= STRAPI_PENDING_MAX_ATTEMPTS) {
    await skipPendingEvent({
      db: args.db,
      pending: args.pending,
      reason: args.message,
      attempts: nextAttempts,
      lastError: args.message,
      signal: args.signal,
    });
    return;
  }
  await args.db.transaction(async (tx) => {
    const lockKey = pendingEventLockKey(args.pending);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
    args.signal.throwIfAborted();
    await tx
      .update(strapiWorkflowPendingEvents)
      .set({
        attempts: nextAttempts,
        revision: sql`${strapiWorkflowPendingEvents.revision} + 1`,
        lastError: args.message,
        runAfter: new Date(now() + STRAPI_PENDING_RETRY_MS),
        updatedAt: nowDate(),
      })
      .where(pendingVersionCondition(args.pending));
  });
  args.signal.throwIfAborted();
}

class StrapiPendingEventChangedError extends Error {
  constructor() {
    super("Strapi pending event changed before durable queue admission");
    this.name = "StrapiPendingEventChangedError";
  }
}

async function persistPendingEventProcessed(args: {
  readonly tx: WorkflowQueueAdmissionTransaction;
  readonly pending: StrapiPendingRow;
  readonly signal: AbortSignal;
}): Promise<void> {
  const lockKey = pendingEventLockKey(args.pending);
  await args.tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
  args.signal.throwIfAborted();
  const currentTime = nowDate();
  const [processed] = await args.tx
    .update(strapiWorkflowPendingEvents)
    .set({
      status: "processed",
      processedAt: currentTime,
      updatedAt: currentTime,
    })
    .where(pendingVersionCondition(args.pending))
    .returning({ id: strapiWorkflowPendingEvents.id });
  args.signal.throwIfAborted();
  if (!processed) {
    throw new StrapiPendingEventChangedError();
  }
}

async function loadPendingEventTarget(args: {
  readonly db: Db;
  readonly automationId: string;
  readonly signal: AbortSignal;
}) {
  const [row] = await args.db
    .select({
      automation: zeroWorkflowAutomations,
      agentId: zeroWorkflows.agentId,
      workflowName: zeroWorkflows.name,
      chatThreadId: workflowUserAutomationThreads.chatThreadId,
      integrationId: zeroWorkflowStrapiAutomations.integrationId,
      integrationName: strapiIntegrations.name,
      integrationBaseUrl: strapiIntegrations.baseUrl,
    })
    .from(zeroWorkflowAutomations)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflows.id, zeroWorkflowAutomations.workflowId),
    )
    .innerJoin(
      zeroWorkflowStrapiAutomations,
      eq(
        zeroWorkflowStrapiAutomations.automationId,
        zeroWorkflowAutomations.id,
      ),
    )
    .innerJoin(
      strapiIntegrations,
      eq(strapiIntegrations.id, zeroWorkflowStrapiAutomations.integrationId),
    )
    .leftJoin(
      workflowUserAutomationThreads,
      and(
        eq(workflowUserAutomationThreads.orgId, zeroWorkflowAutomations.orgId),
        eq(
          workflowUserAutomationThreads.userId,
          zeroWorkflowAutomations.ownerUserId,
        ),
        eq(
          workflowUserAutomationThreads.workflowId,
          zeroWorkflowAutomations.workflowId,
        ),
      ),
    )
    .where(eq(zeroWorkflowAutomations.id, args.automationId))
    .limit(1);
  args.signal.throwIfAborted();
  return row ?? null;
}

function runFailureMessage(result: RunFailure): string {
  return result.kind === "conflict"
    ? result.message
    : result.response.body.error.message;
}

async function processPendingEvent(args: {
  readonly db: Db;
  readonly pending: StrapiPendingRow;
  readonly signal: AbortSignal;
  readonly startRun: (
    input: RunWorkflowAutomationNowArgs,
    signal: AbortSignal,
  ) => Promise<RunWorkflowAutomationResult>;
}): Promise<"executed" | "skipped"> {
  const row = await loadPendingEventTarget({
    db: args.db,
    automationId: args.pending.automationId,
    signal: args.signal,
  });

  const config = row
    ? strapiEntryPublishedEventConfigSchema.safeParse(
        row.automation.eventConfig,
      )
    : null;
  if (
    !row ||
    !config?.success ||
    row.automation.kind !== "event" ||
    row.automation.eventType !== "strapi-entry-published" ||
    row.integrationId !== args.pending.integrationId ||
    config.data.integrationId !== args.pending.integrationId ||
    (config.data.contentTypeUid !== undefined &&
      config.data.contentTypeUid !== args.pending.uid) ||
    (config.data.locale !== undefined &&
      !args.pending.locales.includes(config.data.locale)) ||
    !row.chatThreadId ||
    !isFeatureEnabled(FeatureSwitchKey.StrapiIntegration, {
      orgId: row.automation.orgId,
    })
  ) {
    await skipPendingEvent({
      db: args.db,
      pending: args.pending,
      reason: "Automation is no longer active or no longer matches",
      signal: args.signal,
    });
    return "skipped";
  }
  const canFire = await workflowAutomationCanFire(args.db, {
    automation: row.automation,
    agentId: row.agentId,
    signal: args.signal,
  });
  if (!canFire) {
    await skipPendingEvent({
      db: args.db,
      pending: args.pending,
      reason: "Automation owner can no longer run this workflow",
      signal: args.signal,
    });
    return "skipped";
  }

  const appendSystemPrompt = [
    "# Current context",
    'You are running because a Strapi "Entry published" workflow event automation matched a published entry.',
    "The workflow's procedure is available as a skill - execute it now.",
    "This run is linked to a web chat thread; everything you output is shown to the user there.",
    "The Strapi entry body is not included in this automation context. If the workflow needs content fields, use its configured Strapi connector with the instance and document metadata below.",
    "",
    "# Strapi event",
    JSON.stringify(
      {
        automationId: row.automation.id,
        integration: {
          id: row.integrationId,
          name: row.integrationName,
          baseUrl: row.integrationBaseUrl,
        },
        event: "entry.publish",
        uid: args.pending.uid,
        model: args.pending.model,
        documentId: args.pending.documentId,
        locales: [...args.pending.locales].sort(),
        firstEventAt: args.pending.firstEventAt.toISOString(),
        latestEventAt: args.pending.latestEventAt.toISOString(),
      },
      null,
      2,
    ),
  ].join("\n");
  const result = await args.startRun(
    {
      due: {
        automation: row.automation,
        agentId: row.agentId,
        workflowName: row.workflowName,
        chatThreadId: row.chatThreadId,
      },
      apiStartTime: now(),
      triggerSource: "workflow-event",
      appendSystemPrompt,
      triggerBrief: `Strapi published ${args.pending.uid} ${args.pending.documentId} (${args.pending.locales.length} locale${args.pending.locales.length === 1 ? "" : "s"})`,
      callbacks: buildChatOnlyWorkflowAutomationCallbacks(
        row.chatThreadId,
        row.agentId,
      ),
      activePreviousRunPolicy: "allow",
      coalescePendingScheduleRun: false,
      recordLastRunId: false,
      recordLastRunAt: true,
      persistSourceTransition: async (tx) => {
        await persistPendingEventProcessed({
          tx,
          pending: args.pending,
          signal: args.signal,
        });
      },
      dispatchFailedCallbacks: dispatchFailedRunCallbacks,
    },
    args.signal,
  );
  if (result.kind !== "ok" && result.kind !== "enqueued") {
    await retryPendingEvent({
      db: args.db,
      pending: args.pending,
      message: runFailureMessage(result),
      signal: args.signal,
    });
    return "skipped";
  }
  return "executed";
}

export const executeDueStrapiWorkflowEvents$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<{ readonly executed: number; readonly skipped: number }> => {
    const db = set(writeDb$);
    const due = await db
      .select(pendingColumns())
      .from(strapiWorkflowPendingEvents)
      .where(
        and(
          eq(strapiWorkflowPendingEvents.status, "pending"),
          lte(strapiWorkflowPendingEvents.runAfter, nowDate()),
        ),
      )
      .orderBy(asc(strapiWorkflowPendingEvents.runAfter))
      .limit(STRAPI_PENDING_BATCH_SIZE);
    signal.throwIfAborted();

    let executed = 0;
    let skipped = 0;
    for (const pending of due) {
      const result = await settle(
        processPendingEvent({
          db,
          pending,
          signal,
          startRun: (input, childSignal) => {
            return set(runWorkflowAutomationNow$, input, childSignal);
          },
        }),
        signal,
      );
      if (!result.ok) {
        if (result.error instanceof StrapiPendingEventChangedError) {
          continue;
        }
        log.error("Failed to process Strapi workflow event", {
          automationId: pending.automationId,
          pendingEventId: pending.id,
          error: result.error,
        });
        await retryPendingEvent({
          db,
          pending,
          message:
            result.error instanceof Error
              ? result.error.message
              : "Unknown error",
          signal,
        });
        skipped += 1;
        continue;
      }
      if (result.value === "executed") {
        executed += 1;
      } else {
        skipped += 1;
      }
    }
    return { executed, skipped };
  },
);
