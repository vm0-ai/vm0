import { slackUserMentionedEventConfigSchema } from "@vm0/api-contracts/contracts/zero-workflows";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import type { ChatSlackMessageFile } from "@vm0/db/jsonb-contracts/chat-slack-context";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackWorkflowAutomationDeliveries } from "@vm0/db/schema/slack-workflow-automation-delivery";
import {
  zeroWorkflowAutomations,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";

import { logger } from "../../lib/log";
import {
  enrichMessageContent,
  fetchConversationContexts,
  normalizeSlackMessageContent,
  type SlackFile,
  type SlackRichTextBlock,
} from "../../lib/slack-webhook-context";
import { writeDb$, type Db } from "../external/db";
import {
  createSlackClient,
  createSlackUserInfoResolver,
  getMessagePermalink,
} from "../external/slack-message-client";
import { now, nowDate } from "../external/time";
import { settle } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { rolloutCompatibleWorkflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  materializeCanonicalSlackInputAssets$,
  type CanonicalSlackInputAsset,
} from "./canonical-asset.service";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { slackWorkflowAutomationDeliverySchemaAvailable } from "./slack-workflow-automation-schema.service";
import { workflowAutomationCanFire } from "./zero-workflow-automation-access.service";
import { runWorkflowAutomationNow$ } from "./zero-workflow-automation-run.service";
import { ensureWorkflowUserAutomationThread } from "./zero-workflow-user-automation-thread.service";
import { storedWorkflowAutomationContext } from "./workflow-automation-context.service";
import type { WorkflowQueueAdmissionTransaction } from "./workflow-chat-event-queue.service";
import { hasAllSlackBotScopes } from "./zero-slack-data.service";

const L = logger("SlackWorkflowAutomationDelivery");
const PROCESSING_STALE_AFTER_MS = 5 * 60 * 1000;
const SWEEP_LIMIT = 20;

type Delivery = typeof slackWorkflowAutomationDeliveries.$inferSelect;

interface SlackWorkflowAutomationMessageEvent {
  readonly type?: string;
  readonly channel_type?: string;
  readonly user?: string;
  readonly text?: string;
  readonly ts?: string;
  readonly channel?: string;
  readonly thread_ts?: string;
  readonly subtype?: string;
  readonly bot_id?: string;
  readonly app_id?: string;
  readonly bot_profile?: unknown;
  readonly blocks?: readonly SlackRichTextBlock[];
  readonly files?: readonly SlackFile[];
}

interface EligibleSlackWorkflowMessage {
  readonly channelId: string;
  readonly messageTs: string;
  readonly threadTs: string | null;
  readonly senderSlackUserId: string;
  readonly subtype: "file_share" | "thread_broadcast" | null;
  readonly normalizedText: string;
  readonly directlyMentionedUserIds: readonly string[];
  readonly files: readonly ChatSlackMessageFile[];
}

type SlackWorkflowAutomationDiscardReason =
  | "not_message"
  | "not_channel"
  | "unsupported_subtype"
  | "missing_human_identity"
  | "bot_or_app_message"
  | "missing_message_identity"
  | "no_direct_user_mention";

type SlackWorkflowDeliverySkipReason =
  | "runtime_eligibility_changed"
  | "terminal_slack_access_lost"
  | "terminal_slack_file_unavailable";

type SlackWorkflowAutomationMessageEligibility =
  | {
      readonly kind: "eligible";
      readonly message: EligibleSlackWorkflowMessage;
    }
  | {
      readonly kind: "discarded";
      readonly reason: SlackWorkflowAutomationDiscardReason;
    };

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function minimumSlackFileMetadata(file: SlackFile): ChatSlackMessageFile {
  return {
    ...(optionalString(file.id) ? { id: file.id } : {}),
    ...(optionalString(file.name) ? { name: file.name } : {}),
    ...(optionalString(file.title) ? { title: file.title } : {}),
    ...(optionalString(file.mimetype) ? { mimetype: file.mimetype } : {}),
    ...(optionalNumber(file.size) ? { size: file.size } : {}),
    ...(optionalString(file.url_private_download)
      ? { url_private_download: file.url_private_download }
      : {}),
  };
}

function isSlackWorkflowChannel(
  channelType: string | undefined,
  channelId: string | undefined,
): boolean {
  if (channelType === "channel" || channelType === "group") {
    return true;
  }
  return (
    channelType === undefined &&
    (channelId?.startsWith("C") === true || channelId?.startsWith("G") === true)
  );
}

/** Pure eligibility and normalization boundary for verified Slack callbacks. */
function slackWorkflowAutomationMessageEligibility(
  event: SlackWorkflowAutomationMessageEvent,
): SlackWorkflowAutomationMessageEligibility {
  if (event.type !== "message") {
    return { kind: "discarded", reason: "not_message" };
  }
  const channelId = optionalString(event.channel);
  if (!isSlackWorkflowChannel(event.channel_type, channelId)) {
    return { kind: "discarded", reason: "not_channel" };
  }
  if (
    event.subtype !== undefined &&
    event.subtype !== "file_share" &&
    event.subtype !== "thread_broadcast"
  ) {
    return { kind: "discarded", reason: "unsupported_subtype" };
  }
  const senderSlackUserId = optionalString(event.user);
  if (!senderSlackUserId) {
    return { kind: "discarded", reason: "missing_human_identity" };
  }
  if (event.bot_id || event.app_id || event.bot_profile) {
    return { kind: "discarded", reason: "bot_or_app_message" };
  }
  const messageTs = optionalString(event.ts);
  if (!channelId || !messageTs) {
    return { kind: "discarded", reason: "missing_message_identity" };
  }
  const normalized = normalizeSlackMessageContent(event);
  if (normalized.directlyMentionedUserIds.length === 0) {
    return { kind: "discarded", reason: "no_direct_user_mention" };
  }
  return {
    kind: "eligible",
    message: {
      channelId,
      messageTs,
      threadTs: optionalString(event.thread_ts) ?? null,
      senderSlackUserId,
      subtype: event.subtype ?? null,
      normalizedText: normalized.text,
      directlyMentionedUserIds: normalized.directlyMentionedUserIds,
      files: (event.files ?? []).map(minimumSlackFileMetadata),
    },
  };
}

interface MatchingAutomation {
  readonly automation: typeof zeroWorkflowAutomations.$inferSelect;
  readonly agentId: string;
  readonly ownerSlackUserId: string;
}

async function matchingAutomations(args: {
  readonly db: Db;
  readonly workspaceId: string;
  readonly message: EligibleSlackWorkflowMessage;
  readonly signal: AbortSignal;
}): Promise<readonly MatchingAutomation[]> {
  const [installation] = await args.db
    .select({
      orgId: slackOrgInstallations.orgId,
      botScopes: slackOrgInstallations.botScopes,
    })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId))
    .limit(1);
  args.signal.throwIfAborted();
  if (!installation?.orgId || !hasAllSlackBotScopes(installation.botScopes)) {
    return [];
  }

  const rows = await args.db
    .select({
      automation: rolloutCompatibleWorkflowAutomationColumns(false),
      agentId: zeroWorkflows.agentId,
      ownerSlackUserId: slackOrgConnections.slackUserId,
    })
    .from(zeroWorkflowAutomations)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflows.id, zeroWorkflowAutomations.workflowId),
    )
    .innerJoin(
      slackOrgConnections,
      and(
        eq(slackOrgConnections.vm0UserId, zeroWorkflowAutomations.ownerUserId),
        eq(slackOrgConnections.slackWorkspaceId, args.workspaceId),
      ),
    )
    .where(
      and(
        eq(zeroWorkflowAutomations.orgId, installation.orgId),
        eq(zeroWorkflowAutomations.kind, "event"),
        eq(zeroWorkflowAutomations.eventType, "slack-user-mentioned"),
        eq(zeroWorkflowAutomations.enabled, true),
      ),
    );
  args.signal.throwIfAborted();

  const ownerFeatureContexts = new Map<
    string,
    Awaited<ReturnType<typeof loadUserFeatureSwitchContext>>
  >();
  const matches: MatchingAutomation[] = [];
  for (const row of rows) {
    const config = slackUserMentionedEventConfigSchema.safeParse(
      row.automation.eventConfig,
    );
    if (
      !config.success ||
      config.data.channel.id !== args.message.channelId ||
      row.ownerSlackUserId === args.message.senderSlackUserId ||
      !args.message.directlyMentionedUserIds.includes(row.ownerSlackUserId)
    ) {
      continue;
    }
    let featureContext = ownerFeatureContexts.get(row.automation.ownerUserId);
    if (!featureContext) {
      featureContext = await loadUserFeatureSwitchContext(
        args.db,
        row.automation.orgId,
        row.automation.ownerUserId,
      );
      args.signal.throwIfAborted();
      ownerFeatureContexts.set(row.automation.ownerUserId, featureContext);
    }
    if (
      !isFeatureEnabled(
        FeatureSwitchKey.SlackUserMentionAutomations,
        featureContext,
      )
    ) {
      continue;
    }
    const canFire = await workflowAutomationCanFire(args.db, {
      automation: row.automation,
      agentId: row.agentId,
      signal: args.signal,
    });
    args.signal.throwIfAborted();
    if (!canFire) {
      continue;
    }
    matches.push(row);
  }
  return matches;
}

type AdmitSlackWorkflowAutomationCallbackResult =
  | {
      readonly kind: "discarded";
      readonly reason: SlackWorkflowAutomationDiscardReason;
    }
  | { readonly kind: "no_match" }
  | {
      readonly kind: "retry_later";
      readonly reason: "missing_event_id" | "schema_unavailable";
    }
  | {
      readonly kind: "admitted";
      readonly deliveryIds: readonly string[];
      readonly matched: number;
      readonly inserted: number;
      readonly deduplicated: number;
    };

export async function admitSlackWorkflowAutomationCallback(args: {
  readonly db: Db;
  readonly workspaceId: string;
  readonly eventId: string | undefined;
  readonly sharedChannel: boolean;
  readonly event: SlackWorkflowAutomationMessageEvent;
  readonly signal: AbortSignal;
}): Promise<AdmitSlackWorkflowAutomationCallbackResult> {
  const eligibility = slackWorkflowAutomationMessageEligibility(args.event);
  if (eligibility.kind === "discarded") {
    L.debug("Slack Workflow callback discarded", {
      type: "slack_workflow_automation_delivery",
      phase: "admission",
      outcome: "discarded",
      reason: eligibility.reason,
      workspaceId: args.workspaceId,
      subtype: args.event.subtype ?? null,
    });
    return eligibility;
  }
  const { message } = eligibility;
  const matches = await matchingAutomations({
    db: args.db,
    workspaceId: args.workspaceId,
    message,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (matches.length === 0) {
    L.debug("Slack Workflow callback had no match", {
      type: "slack_workflow_automation_delivery",
      phase: "admission",
      outcome: "discarded",
      reason: "no_matching_automation",
      workspaceId: args.workspaceId,
      channelId: message.channelId,
      subtype: message.subtype,
    });
    return { kind: "no_match" };
  }
  if (!args.eventId) {
    return { kind: "retry_later", reason: "missing_event_id" };
  }
  const eventId = args.eventId;
  const schemaAvailable = await slackWorkflowAutomationDeliverySchemaAvailable(
    args.db,
  );
  args.signal.throwIfAborted();
  if (!schemaAvailable) {
    return { kind: "retry_later", reason: "schema_unavailable" };
  }

  const currentTime = nowDate();
  const inserted = await args.db
    .insert(slackWorkflowAutomationDeliveries)
    .values(
      matches.map((match) => {
        return {
          automationId: match.automation.id,
          eventId,
          workspaceId: args.workspaceId,
          channelId: message.channelId,
          messageTs: message.messageTs,
          threadTs: message.threadTs,
          senderSlackUserId: message.senderSlackUserId,
          ownerSlackUserId: match.ownerSlackUserId,
          subtype: message.subtype,
          normalizedText: message.normalizedText,
          sharedChannel: args.sharedChannel,
          files: message.files,
          createdAt: currentTime,
          updatedAt: currentTime,
        };
      }),
    )
    .onConflictDoNothing()
    .returning({ id: slackWorkflowAutomationDeliveries.id });
  args.signal.throwIfAborted();

  const automationIds = matches.map((match) => {
    return match.automation.id;
  });
  const deliveries = await args.db
    .select({
      id: slackWorkflowAutomationDeliveries.id,
      status: slackWorkflowAutomationDeliveries.status,
      updatedAt: slackWorkflowAutomationDeliveries.updatedAt,
    })
    .from(slackWorkflowAutomationDeliveries)
    .where(
      and(
        inArray(slackWorkflowAutomationDeliveries.automationId, automationIds),
        eq(slackWorkflowAutomationDeliveries.workspaceId, args.workspaceId),
        eq(slackWorkflowAutomationDeliveries.channelId, message.channelId),
        eq(slackWorkflowAutomationDeliveries.messageTs, message.messageTs),
      ),
    );
  args.signal.throwIfAborted();
  const staleBefore = new Date(
    currentTime.getTime() - PROCESSING_STALE_AFTER_MS,
  );
  const deliveryIds = deliveries.flatMap((delivery) => {
    return delivery.status === "pending" ||
      delivery.status === "failed" ||
      (delivery.status === "processing" && delivery.updatedAt < staleBefore)
      ? [delivery.id]
      : [];
  });
  L.debug("Slack Workflow callback admitted", {
    type: "slack_workflow_automation_delivery",
    phase: "admission",
    outcome: "admitted",
    workspaceId: args.workspaceId,
    channelId: message.channelId,
    subtype: message.subtype,
    matched: matches.length,
    inserted: inserted.length,
    deduplicated: matches.length - inserted.length,
  });
  return {
    kind: "admitted",
    deliveryIds,
    matched: matches.length,
    inserted: inserted.length,
    deduplicated: matches.length - inserted.length,
  };
}

class SlackWorkflowDeliveryError extends Error {
  readonly phase: string;
  readonly code: string;
  readonly rateLimited: boolean;
  readonly terminalSkipReason: SlackWorkflowDeliverySkipReason | undefined;

  constructor(
    phase: string,
    code: string,
    options: {
      readonly rateLimited?: boolean;
      readonly terminalSkipReason?: SlackWorkflowDeliverySkipReason;
    } = {},
  ) {
    super("Slack Workflow delivery processing failed");
    this.name = "SlackWorkflowDeliveryError";
    this.phase = phase;
    this.code = code;
    this.rateLimited = options.rateLimited ?? false;
    this.terminalSkipReason = options.terminalSkipReason;
  }
}

function safeErrorCode(value: unknown): string {
  if (typeof value !== "string") {
    return "unknown";
  }
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9_-]/g, "_");
  return normalized.slice(0, 80) || "unknown";
}

function slackApiErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("data" in error) {
      const data = error.data;
      if (
        typeof data === "object" &&
        data !== null &&
        "error" in data &&
        typeof data.error === "string"
      ) {
        return safeErrorCode(data.error);
      }
    }
    if ("code" in error && typeof error.code === "string") {
      return safeErrorCode(error.code);
    }
  }
  return "slack_api_error";
}

function isRateLimitCode(code: string): boolean {
  return code.includes("rate_limit") || code === "ratelimited";
}

function terminalSlackAccessSkipReason(
  code: string,
): SlackWorkflowDeliverySkipReason | undefined {
  switch (code) {
    case "account_inactive":
    case "channel_not_found":
    case "ekm_access_denied":
    case "enterprise_is_restricted":
    case "invalid_auth":
    case "is_archived":
    case "missing_scope":
    case "no_permission":
    case "not_allowed_token_type":
    case "not_authed":
    case "not_in_channel":
    case "team_access_not_granted":
    case "token_expired":
    case "token_revoked": {
      return "terminal_slack_access_lost";
    }
    default: {
      return undefined;
    }
  }
}

async function requiredSlackPhase<T>(
  phase: string,
  operation: () => Promise<T>,
): Promise<T> {
  const result = await settle(operation());
  if (result.ok) {
    return result.value;
  }
  const code = slackApiErrorCode(result.error);
  throw new SlackWorkflowDeliveryError(phase, code, {
    rateLimited: isRateLimitCode(code),
    terminalSkipReason: terminalSlackAccessSkipReason(code),
  });
}

async function claimDelivery(
  db: Db,
  deliveryId: string,
  currentTime: Date,
): Promise<Delivery | null> {
  const staleBefore = new Date(
    currentTime.getTime() - PROCESSING_STALE_AFTER_MS,
  );
  const [claimed] = await db
    .update(slackWorkflowAutomationDeliveries)
    .set({
      status: "processing",
      attempts: sql`${slackWorkflowAutomationDeliveries.attempts} + 1`,
      lastError: null,
      skipReason: null,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(slackWorkflowAutomationDeliveries.id, deliveryId),
        or(
          inArray(slackWorkflowAutomationDeliveries.status, [
            "pending",
            "failed",
          ]),
          and(
            eq(slackWorkflowAutomationDeliveries.status, "processing"),
            lt(slackWorkflowAutomationDeliveries.updatedAt, staleBefore),
          ),
        ),
      ),
    )
    .returning();
  return claimed ?? null;
}

async function skipClaimedDelivery(args: {
  readonly db: Db;
  readonly delivery: Delivery;
  readonly reason: SlackWorkflowDeliverySkipReason;
  readonly error?: SlackWorkflowDeliveryError;
  readonly signal: AbortSignal;
}): Promise<void> {
  const currentTime = nowDate();
  const [skipped] = await args.db
    .update(slackWorkflowAutomationDeliveries)
    .set({
      status: "skipped",
      skipReason: args.reason,
      processedAt: currentTime,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(slackWorkflowAutomationDeliveries.id, args.delivery.id),
        eq(slackWorkflowAutomationDeliveries.status, "processing"),
        eq(slackWorkflowAutomationDeliveries.attempts, args.delivery.attempts),
      ),
    )
    .returning({ id: slackWorkflowAutomationDeliveries.id });
  args.signal.throwIfAborted();
  if (!skipped) {
    throw new SlackWorkflowDeliveryError("eligibility", "claim_lost");
  }
  L.debug("Slack Workflow delivery skipped", {
    type: "slack_workflow_automation_delivery",
    phase: args.error?.phase ?? "eligibility",
    outcome: "skipped",
    deliveryId: args.delivery.id,
    automationId: args.delivery.automationId,
    workspaceId: args.delivery.workspaceId,
    channelId: args.delivery.channelId,
    subtype: args.delivery.subtype,
    attempt: args.delivery.attempts,
    reason: args.reason,
    ...(args.error ? { errorClass: args.error.code } : {}),
  });
}

async function markDeliveryFailed(
  db: Db,
  delivery: Delivery,
  error: unknown,
): Promise<void> {
  const phase =
    error instanceof SlackWorkflowDeliveryError ? error.phase : "processing";
  const code =
    error instanceof SlackWorkflowDeliveryError
      ? error.code
      : safeErrorCode(
          error instanceof Error ? error.constructor.name : typeof error,
        );
  await db
    .update(slackWorkflowAutomationDeliveries)
    .set({
      status: "failed",
      lastError: `${safeErrorCode(phase)}:${safeErrorCode(code)}`,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(slackWorkflowAutomationDeliveries.id, delivery.id),
        eq(slackWorkflowAutomationDeliveries.status, "processing"),
        eq(slackWorkflowAutomationDeliveries.attempts, delivery.attempts),
      ),
    );
  L.error("Slack Workflow delivery failed", {
    type: "slack_workflow_automation_delivery",
    phase,
    outcome: "failed",
    deliveryId: delivery.id,
    automationId: delivery.automationId,
    workspaceId: delivery.workspaceId,
    channelId: delivery.channelId,
    subtype: delivery.subtype,
    attempt: delivery.attempts,
    errorClass: code,
    rateLimited:
      error instanceof SlackWorkflowDeliveryError && error.rateLimited,
  });
}

async function loadDeliveryTarget(db: Db, automationId: string) {
  const [row] = await db
    .select({
      automation: rolloutCompatibleWorkflowAutomationColumns(false),
      agentId: zeroWorkflows.agentId,
      workflowName: zeroWorkflows.name,
      workflowTitle: zeroWorkflows.displayName,
    })
    .from(zeroWorkflowAutomations)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflows.id, zeroWorkflowAutomations.workflowId),
    )
    .where(eq(zeroWorkflowAutomations.id, automationId))
    .limit(1);
  return row ?? null;
}

type DeliveryTarget = NonNullable<
  Awaited<ReturnType<typeof loadDeliveryTarget>>
>;
type DeliveryInstallation = {
  readonly workspaceId: string;
  readonly orgId: string | null;
  readonly encryptedBotToken: string;
  readonly botScopes: string | null;
};

function deliveryTargetMatches(
  target: DeliveryTarget | null,
  delivery: Delivery,
): target is DeliveryTarget {
  if (!target) {
    return false;
  }
  const config = slackUserMentionedEventConfigSchema.safeParse(
    target.automation.eventConfig,
  );
  return (
    config.success &&
    target.automation.kind === "event" &&
    target.automation.eventType === "slack-user-mentioned" &&
    config.data.channel.id === delivery.channelId
  );
}

async function loadDeliveryInstallation(
  db: Db,
  workspaceId: string,
): Promise<DeliveryInstallation | null> {
  const [installation] = await db
    .select({
      workspaceId: slackOrgInstallations.slackWorkspaceId,
      orgId: slackOrgInstallations.orgId,
      encryptedBotToken: slackOrgInstallations.encryptedBotToken,
      botScopes: slackOrgInstallations.botScopes,
    })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);
  return installation ?? null;
}

async function loadDeliveryOwnerSlackUserId(
  db: Db,
  target: DeliveryTarget,
  workspaceId: string,
): Promise<string | null> {
  const [connection] = await db
    .select({ slackUserId: slackOrgConnections.slackUserId })
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.vm0UserId, target.automation.ownerUserId),
        eq(slackOrgConnections.slackWorkspaceId, workspaceId),
      ),
    )
    .limit(1);
  return connection?.slackUserId ?? null;
}

type DeliveryFeatureContext = Awaited<
  ReturnType<typeof loadUserFeatureSwitchContext>
>;
type EligibleDeliveryTarget = {
  readonly target: DeliveryTarget;
  readonly installation: DeliveryInstallation;
  readonly featureContext: DeliveryFeatureContext;
};

async function resolveEligibleDeliveryTarget(args: {
  readonly db: Db;
  readonly delivery: Delivery;
  readonly signal: AbortSignal;
}): Promise<EligibleDeliveryTarget | null> {
  const target = await loadDeliveryTarget(args.db, args.delivery.automationId);
  args.signal.throwIfAborted();
  if (!deliveryTargetMatches(target, args.delivery)) {
    return null;
  }
  const [installation, ownerSlackUserId, featureContext] = await Promise.all([
    loadDeliveryInstallation(args.db, args.delivery.workspaceId),
    loadDeliveryOwnerSlackUserId(args.db, target, args.delivery.workspaceId),
    loadUserFeatureSwitchContext(
      args.db,
      target.automation.orgId,
      target.automation.ownerUserId,
    ),
  ]);
  args.signal.throwIfAborted();
  const canFire = await workflowAutomationCanFire(args.db, {
    automation: target.automation,
    agentId: target.agentId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (
    !installation?.orgId ||
    installation.orgId !== target.automation.orgId ||
    !hasAllSlackBotScopes(installation.botScopes) ||
    ownerSlackUserId !== args.delivery.ownerSlackUserId ||
    args.delivery.senderSlackUserId === ownerSlackUserId ||
    !isFeatureEnabled(
      FeatureSwitchKey.SlackUserMentionAutomations,
      featureContext,
    ) ||
    !canFire
  ) {
    return null;
  }
  return { target, installation, featureContext };
}

async function ensureDeliveryChatThread(
  db: Db,
  target: DeliveryTarget,
): Promise<string> {
  return await db.transaction(async (tx) => {
    return await ensureWorkflowUserAutomationThread(tx, {
      orgId: target.automation.orgId,
      userId: target.automation.ownerUserId,
      workflowId: target.automation.workflowId,
      agentId: target.agentId,
      workflowTitle: target.workflowTitle ?? target.workflowName,
      currentTime: nowDate(),
    });
  });
}

function requireReadyDeliveryAssets(
  assets: readonly CanonicalSlackInputAsset[],
  expectedCount: number,
): void {
  const failedAsset = assets.find((asset) => {
    return asset.status !== "ready";
  });
  if (assets.length !== expectedCount || failedAsset) {
    throw new SlackWorkflowDeliveryError(
      "files",
      failedAsset?.error?.code ?? "materialization_incomplete",
      {
        terminalSkipReason:
          assets.length !== expectedCount ||
          failedAsset?.error?.retryable === false
            ? "terminal_slack_file_unavailable"
            : undefined,
      },
    );
  }
}

async function loadDeliverySlackContent(
  client: ReturnType<typeof createSlackClient>,
  delivery: Delivery,
) {
  const userInfoResolver = createSlackUserInfoResolver(client);
  return await Promise.all([
    requiredSlackPhase("user_info", async () => {
      return await enrichMessageContent({
        messageContent: delivery.normalizedText,
        files: undefined,
        client,
        userId: delivery.senderSlackUserId,
        userInfoResolver,
      });
    }),
    requiredSlackPhase("context", async () => {
      return await fetchConversationContexts(
        client,
        delivery.channelId,
        delivery.threadTs ?? undefined,
        delivery.messageTs,
        { userInfoResolver },
      );
    }),
    requiredSlackPhase("permalink", async () => {
      const result = await getMessagePermalink(
        client,
        delivery.channelId,
        delivery.messageTs,
      );
      if (result.kind !== "ok") {
        throw new SlackWorkflowDeliveryError(
          "permalink",
          safeErrorCode(result.error),
          {
            rateLimited: isRateLimitCode(result.error),
            terminalSkipReason: terminalSlackAccessSkipReason(
              safeErrorCode(result.error),
            ),
          },
        );
      }
      return result.permalink;
    }),
  ]);
}

function slackWorkflowDeliveryEventPayload(args: {
  readonly target: DeliveryTarget;
  readonly delivery: Delivery;
  readonly enriched: Awaited<ReturnType<typeof enrichMessageContent>>;
  readonly conversationContext: string;
  readonly permalink: string;
  readonly assets: readonly CanonicalSlackInputAsset[];
}) {
  const { delivery, enriched } = args;
  return {
    deliveryId: delivery.id,
    automationId: args.target.automation.id,
    eventId: delivery.eventId,
    workspaceId: delivery.workspaceId,
    channelId: delivery.channelId,
    ownerSlackUserId: delivery.ownerSlackUserId,
    ownerMentionDisplayName:
      enriched.mentionDisplayNames[delivery.ownerSlackUserId] ?? null,
    senderSlackUserId: delivery.senderSlackUserId,
    senderDisplayName: enriched.userInfoExtras.slackDisplayName ?? null,
    text: enriched.prompt,
    messageTs: delivery.messageTs,
    threadTs: delivery.threadTs,
    subtype: delivery.subtype,
    permalink: args.permalink,
    sharedChannel: delivery.sharedChannel,
    mentionDisplayNames: enriched.mentionDisplayNames,
    files: args.assets.map((asset) => {
      return {
        assetId: asset.assetId,
        position: asset.position,
        filename: asset.filename,
        contentType: asset.contentType,
        size: asset.size,
      };
    }),
    conversationContext: args.conversationContext,
  };
}

function persistDeliveryProcessed(delivery: Delivery, signal: AbortSignal) {
  return async (tx: WorkflowQueueAdmissionTransaction): Promise<void> => {
    const currentTime = nowDate();
    const [processed] = await tx
      .update(slackWorkflowAutomationDeliveries)
      .set({
        status: "processed",
        processedAt: currentTime,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(slackWorkflowAutomationDeliveries.id, delivery.id),
          eq(slackWorkflowAutomationDeliveries.status, "processing"),
          eq(slackWorkflowAutomationDeliveries.attempts, delivery.attempts),
        ),
      )
      .returning({ id: slackWorkflowAutomationDeliveries.id });
    signal.throwIfAborted();
    if (!processed) {
      throw new SlackWorkflowDeliveryError("queue", "claim_lost");
    }
  };
}

const dispatchClaimedSlackWorkflowDelivery$ = command(
  async (
    { set },
    args: { readonly db: Db; readonly delivery: Delivery },
    signal: AbortSignal,
  ): Promise<"processed" | "skipped"> => {
    const { db, delivery } = args;
    const eligible = await resolveEligibleDeliveryTarget({
      db,
      delivery,
      signal,
    });
    if (!eligible) {
      await skipClaimedDelivery({
        db,
        delivery,
        reason: "runtime_eligibility_changed",
        signal,
      });
      return "skipped";
    }
    const { target, installation, featureContext } = eligible;
    const chatThreadId = await ensureDeliveryChatThread(db, target);
    signal.throwIfAborted();
    const botToken = await decryptPersistentSecretValue(
      installation.encryptedBotToken,
      featureContext,
    );
    signal.throwIfAborted();
    const client = createSlackClient(botToken);
    const assets = await requiredSlackPhase("files", async () => {
      return await set(
        materializeCanonicalSlackInputAssets$,
        {
          userId: target.automation.ownerUserId,
          orgId: target.automation.orgId,
          chatThreadId,
          workspaceId: delivery.workspaceId,
          channelId: delivery.channelId,
          messageTs: delivery.messageTs,
          botToken,
          files: delivery.files,
        },
        signal,
      );
    });
    signal.throwIfAborted();
    requireReadyDeliveryAssets(assets, delivery.files.length);
    const [enriched, conversation, permalink] = await loadDeliverySlackContent(
      client,
      delivery,
    );
    signal.throwIfAborted();

    const eventPayload = slackWorkflowDeliveryEventPayload({
      target,
      delivery,
      enriched,
      conversationContext: conversation.executionContext,
      permalink,
      assets,
    });
    const result = await set(
      runWorkflowAutomationNow$,
      {
        due: {
          automation: target.automation,
          agentId: target.agentId,
          chatThreadId,
        },
        automationContext: storedWorkflowAutomationContext({
          workflowName: target.workflowName,
          eventType: "slack-user-mentioned",
          eventPayload,
        }),
        apiStartTime: now(),
        triggerSource: "workflow-event",
        triggerBrief: `Slack mention in channel ${delivery.channelId}`,
        coalescePendingScheduleRun: false,
        eventAssets: assets.map((asset) => {
          return { assetId: asset.assetId, position: asset.position };
        }),
        persistSourceTransition: persistDeliveryProcessed(delivery, signal),
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind !== "ok" && result.kind !== "enqueued") {
      throw new SlackWorkflowDeliveryError("queue", result.kind);
    }
    L.debug("Slack Workflow delivery processed", {
      type: "slack_workflow_automation_delivery",
      phase: "dispatch",
      outcome: result.kind,
      deliveryId: delivery.id,
      automationId: delivery.automationId,
      workspaceId: delivery.workspaceId,
      channelId: delivery.channelId,
      subtype: delivery.subtype,
      attempt: delivery.attempts,
      triggerLatencyMs: nowDate().getTime() - delivery.createdAt.getTime(),
    });
    return "processed";
  },
);

export const processSlackWorkflowAutomationDelivery$ = command(
  async (
    { set },
    args: { readonly deliveryId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const delivery = await claimDelivery(db, args.deliveryId, nowDate());
    signal.throwIfAborted();
    if (!delivery) {
      return false;
    }
    const result = await settle(
      set(dispatchClaimedSlackWorkflowDelivery$, { db, delivery }, signal),
      signal,
    );
    signal.throwIfAborted();
    if (result.ok) {
      return true;
    }
    if (
      result.error instanceof SlackWorkflowDeliveryError &&
      result.error.terminalSkipReason
    ) {
      await skipClaimedDelivery({
        db,
        delivery,
        reason: result.error.terminalSkipReason,
        error: result.error,
        signal,
      });
      return true;
    }
    await markDeliveryFailed(db, delivery, result.error);
    signal.throwIfAborted();
    throw result.error;
  },
);

export const drainStaleSlackWorkflowAutomationDeliveries$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const schemaAvailable =
      await slackWorkflowAutomationDeliverySchemaAvailable(db);
    signal.throwIfAborted();
    if (!schemaAvailable) {
      return 0;
    }
    const staleBefore = new Date(
      nowDate().getTime() - PROCESSING_STALE_AFTER_MS,
    );
    const rows = await db
      .select({ id: slackWorkflowAutomationDeliveries.id })
      .from(slackWorkflowAutomationDeliveries)
      .where(
        or(
          inArray(slackWorkflowAutomationDeliveries.status, [
            "pending",
            "failed",
          ]),
          and(
            eq(slackWorkflowAutomationDeliveries.status, "processing"),
            lt(slackWorkflowAutomationDeliveries.updatedAt, staleBefore),
          ),
        ),
      )
      .orderBy(
        asc(slackWorkflowAutomationDeliveries.updatedAt),
        asc(slackWorkflowAutomationDeliveries.createdAt),
        asc(slackWorkflowAutomationDeliveries.id),
      )
      .limit(SWEEP_LIMIT);
    signal.throwIfAborted();
    let processed = 0;
    for (const row of rows) {
      const result = await settle(
        set(
          processSlackWorkflowAutomationDelivery$,
          { deliveryId: row.id },
          signal,
        ),
        signal,
      );
      signal.throwIfAborted();
      if (result.ok && result.value) {
        processed += 1;
      }
    }
    return processed;
  },
);
