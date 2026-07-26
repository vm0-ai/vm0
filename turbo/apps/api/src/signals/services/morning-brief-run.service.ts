import { randomBytes } from "node:crypto";

import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  morningBriefDeliveries,
  morningBriefSchedules,
} from "@vm0/db/schema/morning-brief";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { command } from "ccstate";
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import {
  generatePresignedGetUrl,
  generatePresignedPutUrl,
  putS3Object,
} from "../external/s3";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { settle } from "../utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import {
  collectMorningBriefInput,
  type MorningBriefInput,
} from "./morning-brief-collect.service";
import {
  morningBriefDayBounds,
  morningBriefLocalDate,
  nextMorningBriefRunAt,
} from "./morning-brief-schedule.service";
import { resolveDefaultAgent } from "./zero-email-common.service";
import {
  postRunUserMessage,
  resolveRunChatThreadModelContext,
} from "./zero-chat-run-message.service";
import type { ModelFirstPin } from "./zero-model-selection.service";
import { createZeroRun$ } from "./zero-runs-create.service";
import { createAutomationChatThread } from "./zero-workflow-user-automation-thread.service";

const log = logger("api:morning-brief");

const CLAIM_LIMIT = 50;
const PROCESS_CONCURRENCY = 5;
const MAX_LOOKBACK_MS = 72 * 60 * 60 * 1000;
const MIN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SIGNED_URL_TTL_SECONDS = 30 * 60;
const MORNING_BRIEF_THREAD_TITLE = "Morning Brief";

interface ExecuteMorningBriefsResult {
  readonly executed: number;
  readonly skipped: number;
}

interface DueMorningBriefRow {
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string | null;
  readonly nextRunAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly timezone: string | null;
  readonly enabled: boolean;
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function morningBriefStorageKey(
  orgId: string,
  userId: string,
  briefDate: string,
  filename: string,
): string {
  return `morning-brief/${orgId}/${userId}/${briefDate}/${filename}`;
}

/** Optimistic claim: advance next_run_at only if it is still the observed value. */
async function claimSchedule(
  db: Db,
  row: DueMorningBriefRow,
  currentTime: Date,
): Promise<boolean> {
  if (!row.nextRunAt || !row.timezone) {
    return false;
  }
  const claimed = await db
    .update(morningBriefSchedules)
    .set({
      nextRunAt: nextMorningBriefRunAt(row.timezone, currentTime),
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(morningBriefSchedules.orgId, row.orgId),
        eq(morningBriefSchedules.userId, row.userId),
        eq(morningBriefSchedules.nextRunAt, row.nextRunAt),
      ),
    )
    .returning({ orgId: morningBriefSchedules.orgId });
  return claimed.length > 0;
}

async function markDeliveryFailed(
  db: Db,
  deliveryId: string,
  error: string,
  currentTime: Date,
): Promise<void> {
  await db
    .update(morningBriefDeliveries)
    .set({ status: "failed", error, updatedAt: currentTime })
    .where(eq(morningBriefDeliveries.id, deliveryId));
}

function buildMorningBriefPrompt(briefDate: string): string {
  return `Generate my Morning Brief for ${briefDate}.`;
}

function buildMorningBriefAppendSystemPrompt(args: {
  readonly briefDate: string;
  readonly timezone: string;
  readonly inputUrl: string;
  readonly outputUrl: string;
}): string {
  return [
    "# Morning Brief run",
    `You are generating the user's Morning Brief for ${args.briefDate} (timezone ${args.timezone}).`,
    "",
    "1. Download the collected data (GitHub, Gmail, Google Calendar, unread vm0 chat threads) with an HTTP GET request to this URL (valid for 30 minutes):",
    args.inputUrl,
    "2. Analyze the data and write the brief. Only use predefined sections, omit empty ones, order by importance:",
    "   - `schedule`: today's meetings and events",
    "   - `needs_attention`: items that need the user's action or reply",
    "   - `unread_threads`: vm0 chat threads with results the user has not read yet — summarize what each task produced while they were away",
    "   - `github_updates`: PRs, reviews, CI, mentions involving the user",
    "   - `email_updates`: notable email threads",
    "   - `suggestions`: at most 3 suggestions, each grounded in today's data",
    "3. Keep it a 3-5 minute read: at most 5 primary items per section; fold the rest into a single 'N more updates' item. Do not pad.",
    "4. After choosing the final section items, write `headline` as the email opening:",
    "   - Begin exactly with `Good morning.`",
    "   - Derive it from the final sections and summarize the overall shape of the brief without sensitive details.",
    "   - Use one or two short sentences, no more than 180 characters. Do not repeat a section title or list every item.",
    "5. Upload the result as JSON with an HTTP PUT request (Content-Type: application/json) to this URL (valid for 30 minutes):",
    args.outputUrl,
    "   The JSON shape is:",
    "   {",
    '     "version": 1,',
    '     "headline": "natural opening derived from the final sections; begins with Good morning.",',
    '     "sections": [{"key": "schedule|needs_attention|unread_threads|github_updates|email_updates|suggestions", "title": "string", "items": [{"title": "string", "detail": "string (optional)", "url": "https source link (optional)"}]}]',
    "   }",
    "   Item `url` values must point at the original Gmail message, Calendar event, GitHub page, or the vm0 chat thread `url` provided in the input.",
    "6. Also post the same brief as well-formatted Markdown in this chat so the user can read it here and ask follow-up questions.",
    "7. If a source in the input is marked failed, mention briefly in the brief that the source was unavailable.",
    "The email is assembled server-side from the uploaded JSON; do not try to send any email yourself.",
  ].join("\n");
}

function allSourcesFailed(input: MorningBriefInput): boolean {
  return (
    !input.sources.github.ok &&
    !input.sources.gmail.ok &&
    !input.sources.calendar.ok &&
    !input.sources.chatThreads.ok
  );
}

interface ClaimedMorningBrief {
  readonly row: DueMorningBriefRow;
  readonly timezone: string;
  readonly briefDate: string;
  readonly deliveryId: string;
  readonly currentTime: Date;
  readonly structuredPromptEnabled: boolean;
}

/** Feature and once-per-local-date gates; claims the delivery row. */
async function admitMorningBriefDelivery(
  db: Db,
  row: DueMorningBriefRow,
  currentTime: Date,
  signal: AbortSignal,
): Promise<ClaimedMorningBrief | null> {
  const timezone = row.timezone;
  if (!timezone || !row.enabled) {
    return null;
  }

  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    row.orgId,
    row.userId,
  );
  signal.throwIfAborted();
  if (!isFeatureEnabled(FeatureSwitchKey.MorningBrief, featureSwitchContext)) {
    return null;
  }

  const briefDate = morningBriefLocalDate(timezone, currentTime);
  const [delivery] = await db
    .insert(morningBriefDeliveries)
    .values({
      orgId: row.orgId,
      userId: row.userId,
      briefDate,
      status: "collecting",
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoNothing()
    .returning({ id: morningBriefDeliveries.id });
  signal.throwIfAborted();
  if (!delivery) {
    // A delivery for this local date already exists; nothing to do.
    return null;
  }

  return {
    row,
    timezone,
    briefDate,
    deliveryId: delivery.id,
    currentTime,
    structuredPromptEnabled: isFeatureEnabled(
      FeatureSwitchKey.StructuredPrompt,
      featureSwitchContext,
    ),
  };
}

interface StagedMorningBriefInput {
  readonly inputKey: string;
  readonly outputKey: string;
  readonly inputUrl: string;
  readonly outputUrl: string;
}

const stageMorningBriefInput$ = command(
  async (
    { get, set },
    claimed: ClaimedMorningBrief,
    signal: AbortSignal,
  ): Promise<StagedMorningBriefInput | null> => {
    const { row, timezone, briefDate, currentTime } = claimed;
    const db = set(writeDb$);

    // Collection window: from the last successful brief, clamped to always
    // cover at least the last 24h and at most the last 72h.
    const sinceFloor = currentTime.getTime() - MAX_LOOKBACK_MS;
    const sinceCeil = currentTime.getTime() - MIN_LOOKBACK_MS;
    const lastSuccess = row.lastSuccessAt?.getTime() ?? sinceFloor;
    const since = new Date(
      Math.min(Math.max(lastSuccess, sinceFloor), sinceCeil),
    );
    const { dayStart, dayEnd } = morningBriefDayBounds(timezone, currentTime);

    const input = await collectMorningBriefInput({
      db,
      orgId: row.orgId,
      userId: row.userId,
      briefDate,
      timezone,
      since,
      until: currentTime,
      dayStart,
      dayEnd,
      excludeChatThreadId: row.chatThreadId,
      structuredPromptEnabled: claimed.structuredPromptEnabled,
      signal,
    });
    signal.throwIfAborted();

    if (allSourcesFailed(input)) {
      await markDeliveryFailed(
        db,
        claimed.deliveryId,
        "All morning brief sources failed",
        currentTime,
      );
      signal.throwIfAborted();
      return null;
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const inputKey = morningBriefStorageKey(
      row.orgId,
      row.userId,
      briefDate,
      "input.json",
    );
    const outputKey = morningBriefStorageKey(
      row.orgId,
      row.userId,
      briefDate,
      "output.json",
    );
    await get(
      putS3Object(bucket, inputKey, JSON.stringify(input), "application/json"),
    );
    signal.throwIfAborted();
    const inputUrl = await get(
      generatePresignedGetUrl(bucket, inputKey, SIGNED_URL_TTL_SECONDS),
    );
    signal.throwIfAborted();
    const outputUrl = await get(
      generatePresignedPutUrl(
        bucket,
        outputKey,
        "application/json",
        SIGNED_URL_TTL_SECONDS,
      ),
    );
    signal.throwIfAborted();

    return { inputKey, outputKey, inputUrl, outputUrl };
  },
);

async function ensureMorningBriefChatThread(
  db: Db,
  claimed: ClaimedMorningBrief,
  agentId: string,
): Promise<string> {
  const { row, currentTime } = claimed;
  if (row.chatThreadId) {
    return row.chatThreadId;
  }
  const chatThreadId = await createAutomationChatThread(db, {
    userId: row.userId,
    orgId: row.orgId,
    agentId,
    title: MORNING_BRIEF_THREAD_TITLE,
    currentTime,
  });
  await db
    .update(morningBriefSchedules)
    .set({ chatThreadId, updatedAt: currentTime })
    .where(
      and(
        eq(morningBriefSchedules.orgId, row.orgId),
        eq(morningBriefSchedules.userId, row.userId),
      ),
    );
  return chatThreadId;
}

interface MorningBriefModelContext {
  readonly modelPin: ModelFirstPin;
  readonly effectiveModelProvider: string | null | undefined;
  readonly cliAgentType: string | null;
  readonly codexServiceTier: "fast" | undefined;
}

async function resolveMorningBriefModelContext(
  db: Db,
  claimed: ClaimedMorningBrief,
  chatThreadId: string,
): Promise<MorningBriefModelContext | null> {
  const { row, deliveryId, currentTime } = claimed;
  const modelContext = await resolveRunChatThreadModelContext({
    db,
    orgId: row.orgId,
    userId: row.userId,
    threadId: chatThreadId,
  });
  if ("status" in modelContext) {
    // Credit / provider admission problems skip silently by design; the
    // schedule already points at tomorrow 7:00.
    await markDeliveryFailed(
      db,
      deliveryId,
      modelContext.body.error.message,
      currentTime,
    );
    return null;
  }
  const { pin, providerAdmission, runCodexServiceTier } = modelContext;
  if (providerAdmission.error) {
    await markDeliveryFailed(
      db,
      deliveryId,
      providerAdmission.error.body.error.message,
      currentTime,
    );
    return null;
  }
  return {
    modelPin: pin,
    effectiveModelProvider: providerAdmission.effectiveModelProvider,
    cliAgentType: providerAdmission.cliAgentType,
    codexServiceTier: runCodexServiceTier,
  };
}

async function recordMorningBriefRunStart(
  db: Db,
  args: {
    readonly claimed: ClaimedMorningBrief;
    readonly staged: StagedMorningBriefInput;
    readonly model: MorningBriefModelContext;
    readonly chatThreadId: string;
    readonly runId: string;
    readonly runStatus: string;
    readonly prompt: string;
  },
): Promise<void> {
  const { claimed, staged, model } = args;
  await postRunUserMessage({
    db,
    threadId: args.chatThreadId,
    userId: claimed.row.userId,
    runId: args.runId,
    prompt: args.prompt,
    appendQueueMarker: args.runStatus === "queued",
  });

  await db
    .update(zeroRuns)
    .set({
      modelProvider: model.effectiveModelProvider,
      modelProviderId: model.modelPin.modelProviderId,
      modelProviderCredentialScope: model.modelPin.modelProviderCredentialScope,
      selectedModel: model.modelPin.selectedModel,
    })
    .where(eq(zeroRuns.id, args.runId));

  await db
    .update(morningBriefDeliveries)
    .set({
      status: "running",
      runId: args.runId,
      inputKey: staged.inputKey,
      outputKey: staged.outputKey,
      updatedAt: claimed.currentTime,
    })
    .where(eq(morningBriefDeliveries.id, claimed.deliveryId));
}

const startMorningBriefRun$ = command(
  async (
    { set },
    args: {
      readonly claimed: ClaimedMorningBrief;
      readonly staged: StagedMorningBriefInput;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<{ readonly runId: string } | "skipped"> => {
    const db = set(writeDb$);
    const { claimed, staged } = args;
    const { row, timezone, briefDate, deliveryId, currentTime } = claimed;

    const agentId = await resolveDefaultAgent(db, row.orgId);
    signal.throwIfAborted();
    if (!agentId) {
      await markDeliveryFailed(
        db,
        deliveryId,
        "No default agent configured",
        currentTime,
      );
      signal.throwIfAborted();
      return "skipped";
    }

    const chatThreadId = await ensureMorningBriefChatThread(
      db,
      claimed,
      agentId,
    );
    signal.throwIfAborted();

    const model = await resolveMorningBriefModelContext(
      db,
      claimed,
      chatThreadId,
    );
    signal.throwIfAborted();
    if (!model) {
      return "skipped";
    }

    const prompt = buildMorningBriefPrompt(briefDate);
    const callbacks: {
      readonly internalKind: InternalRunCallbackKind;
      readonly secret: string;
      readonly payload: unknown;
    }[] = [
      {
        internalKind: "morning-brief:email",
        secret: generateCallbackSecret(),
        payload: { deliveryId },
      },
      {
        internalKind: "chat",
        secret: generateCallbackSecret(),
        payload: { threadId: chatThreadId, agentId },
      },
    ];

    const result = await set(
      createZeroRun$,
      {
        auth: {
          orgId: row.orgId,
          orgRole: "member",
          userId: row.userId,
          tokenType: "session",
        },
        body: {
          prompt,
          agentId,
          ...(model.effectiveModelProvider
            ? { modelProvider: model.effectiveModelProvider }
            : {}),
        },
        apiStartTime: args.apiStartTime,
        triggerSource: "workflow-schedule",
        chatThreadId,
        modelProviderId: model.modelPin.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          model.modelPin.modelProviderCredentialScope ?? undefined,
        selectedModelOverride: model.modelPin.selectedModel ?? undefined,
        threadSessionRoute: {
          selectedModel: model.modelPin.selectedModel,
          modelProvider: model.effectiveModelProvider ?? null,
          cliAgentType: model.cliAgentType,
        },
        codexServiceTier: model.codexServiceTier,
        appendSystemPrompt: buildMorningBriefAppendSystemPrompt({
          briefDate,
          timezone,
          inputUrl: staged.inputUrl,
          outputUrl: staged.outputUrl,
        }),
        callbacks,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== 201) {
      await markDeliveryFailed(
        db,
        deliveryId,
        result.body.error.message,
        currentTime,
      );
      signal.throwIfAborted();
      return "skipped";
    }

    await recordMorningBriefRunStart(db, {
      claimed,
      staged,
      model,
      chatThreadId,
      runId: result.body.runId,
      runStatus: result.body.status,
      prompt,
    });
    signal.throwIfAborted();

    return { runId: result.body.runId };
  },
);

const processDueMorningBrief$ = command(
  async (
    { set },
    args: {
      readonly row: DueMorningBriefRow;
      readonly currentTime: Date;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<"executed" | "skipped"> => {
    const db = set(writeDb$);
    const claimed = await admitMorningBriefDelivery(
      db,
      args.row,
      args.currentTime,
      signal,
    );
    if (!claimed) {
      return "skipped";
    }

    const staged = await set(stageMorningBriefInput$, claimed, signal);
    if (!staged) {
      return "skipped";
    }

    const started = await set(
      startMorningBriefRun$,
      { claimed, staged, apiStartTime: args.apiStartTime },
      signal,
    );
    return started === "skipped" ? "skipped" : "executed";
  },
);

type ManualMorningBriefAdmission =
  | { readonly kind: "ok"; readonly claimed: ClaimedMorningBrief }
  | { readonly kind: "forbidden" }
  | { readonly kind: "bad_request"; readonly message: string };

async function admitManualMorningBrief(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
  currentTime: Date,
  signal: AbortSignal,
): Promise<ManualMorningBriefAdmission> {
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    args.orgId,
    args.userId,
  );
  signal.throwIfAborted();
  if (
    !isFeatureEnabled(FeatureSwitchKey.ManualMorningBrief, featureSwitchContext)
  ) {
    return { kind: "forbidden" };
  }

  const [member] = await db
    .select({ timezone: orgMembersMetadata.timezone })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, args.orgId),
        eq(orgMembersMetadata.userId, args.userId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  const timezone = member?.timezone;
  if (!timezone) {
    return {
      kind: "bad_request",
      message: "Set a time zone in Settings before triggering a brief",
    };
  }

  // Ensure a schedule row exists so the created chat thread binding
  // persists across manual triggers (next_run_at stays untouched).
  await db
    .insert(morningBriefSchedules)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoNothing();
  signal.throwIfAborted();

  const [schedule] = await db
    .select({
      chatThreadId: morningBriefSchedules.chatThreadId,
      lastSuccessAt: morningBriefSchedules.lastSuccessAt,
    })
    .from(morningBriefSchedules)
    .where(
      and(
        eq(morningBriefSchedules.orgId, args.orgId),
        eq(morningBriefSchedules.userId, args.userId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  const briefDate = morningBriefLocalDate(timezone, currentTime);
  const [delivery] = await db
    .insert(morningBriefDeliveries)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      briefDate,
      status: "collecting",
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [
        morningBriefDeliveries.orgId,
        morningBriefDeliveries.userId,
        morningBriefDeliveries.briefDate,
      ],
      set: {
        status: "collecting",
        runId: null,
        error: null,
        updatedAt: currentTime,
      },
    })
    .returning({ id: morningBriefDeliveries.id });
  signal.throwIfAborted();
  if (!delivery) {
    throw new Error("Expected the morning brief delivery upsert to return");
  }

  return {
    kind: "ok",
    claimed: {
      row: {
        orgId: args.orgId,
        userId: args.userId,
        chatThreadId: schedule?.chatThreadId ?? null,
        nextRunAt: null,
        lastSuccessAt: schedule?.lastSuccessAt ?? null,
        timezone,
        enabled: true,
      },
      timezone,
      briefDate,
      deliveryId: delivery.id,
      currentTime,
      structuredPromptEnabled: isFeatureEnabled(
        FeatureSwitchKey.StructuredPrompt,
        featureSwitchContext,
      ),
    },
  };
}

type TriggerMorningBriefResult =
  | { readonly kind: "ok"; readonly runId: string; readonly briefDate: string }
  | { readonly kind: "forbidden" }
  | { readonly kind: "bad_request"; readonly message: string };

/**
 * Testing entry point behind the manualMorningBrief feature switch: runs the
 * full collect → run pipeline for the caller immediately, reusing (and
 * resetting) today's delivery row so repeated manual triggers work.
 */
export const triggerMorningBriefNow$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<TriggerMorningBriefResult> => {
    const db = set(writeDb$);
    const currentTime = nowDate();

    const admission = await admitManualMorningBrief(
      db,
      args,
      currentTime,
      signal,
    );
    if (admission.kind !== "ok") {
      return admission;
    }
    const claimed = admission.claimed;

    const staged = await set(stageMorningBriefInput$, claimed, signal);
    if (!staged) {
      return {
        kind: "bad_request",
        message: "All morning brief sources failed",
      };
    }

    const started = await set(
      startMorningBriefRun$,
      { claimed, staged, apiStartTime: args.apiStartTime },
      signal,
    );
    if (started === "skipped") {
      return {
        kind: "bad_request",
        message: "Morning brief run could not be started",
      };
    }

    return { kind: "ok", runId: started.runId, briefDate: claimed.briefDate };
  },
);

export const executeDueMorningBriefs$ = command(
  async (
    { set },
    args: { readonly currentTime: Date; readonly apiStartTime: number },
    signal: AbortSignal,
  ): Promise<ExecuteMorningBriefsResult> => {
    const db = set(writeDb$);
    const { currentTime } = args;

    const due: DueMorningBriefRow[] = await db
      .select({
        orgId: morningBriefSchedules.orgId,
        userId: morningBriefSchedules.userId,
        chatThreadId: morningBriefSchedules.chatThreadId,
        nextRunAt: morningBriefSchedules.nextRunAt,
        lastSuccessAt: morningBriefSchedules.lastSuccessAt,
        timezone: orgMembersMetadata.timezone,
        enabled: orgMembersMetadata.morningBriefEnabled,
      })
      .from(morningBriefSchedules)
      .innerJoin(
        orgMembersMetadata,
        and(
          eq(orgMembersMetadata.orgId, morningBriefSchedules.orgId),
          eq(orgMembersMetadata.userId, morningBriefSchedules.userId),
        ),
      )
      .where(
        and(
          isNotNull(morningBriefSchedules.nextRunAt),
          lte(morningBriefSchedules.nextRunAt, currentTime),
        ),
      )
      .orderBy(asc(morningBriefSchedules.nextRunAt))
      .limit(CLAIM_LIMIT);
    signal.throwIfAborted();

    let executed = 0;
    let skipped = 0;

    const queue = [...due];
    const workers = Array.from(
      { length: Math.min(PROCESS_CONCURRENCY, queue.length) },
      async () => {
        for (;;) {
          const row = queue.shift();
          if (!row) {
            return;
          }
          const claimed = await claimSchedule(db, row, currentTime);
          if (!claimed) {
            skipped += 1;
            continue;
          }
          const outcome = await settle(
            set(
              processDueMorningBrief$,
              { row, currentTime, apiStartTime: args.apiStartTime },
              signal,
            ),
            signal,
          );
          if (outcome.ok && outcome.value === "executed") {
            executed += 1;
          } else {
            skipped += 1;
          }
          if (!outcome.ok) {
            // One member's failure must not stop the batch; the claim already
            // moved their schedule to tomorrow.
            log.error("morning brief processing failed", {
              orgId: row.orgId,
              userId: row.userId,
              error:
                outcome.error instanceof Error
                  ? outcome.error.message
                  : String(outcome.error),
            });
          }
        }
      },
    );
    await Promise.all(workers);
    signal.throwIfAborted();

    return { executed, skipped };
  },
);
