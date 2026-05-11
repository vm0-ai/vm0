import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { after } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import {
  chatMessagesContract,
  type AttachFile,
} from "@vm0/api-contracts/contracts/chat-threads";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { userProfileFromClaims } from "../../../../../src/lib/auth/user-profile-from-claims";
import {
  createZeroRun,
  fetchZeroAgentForRun,
} from "../../../../../src/lib/zero/zero-run-service";
import { resolveOrgWithMetadata } from "../../../../../src/lib/zero/org/resolve-org";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  buildWebChatPrompt,
  buildWebAttachFilesPrompt,
  buildWebChatGoalPrompt,
  buildWebChatIncompleteContext,
  type WebChatGoalContext,
  type WebChatIncompleteRound,
} from "../../../../../src/lib/zero/integration-prompt";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { loadFeatureSwitchOverrides } from "../../../../../src/lib/zero/user/feature-switches-service";
import { randomUUID } from "node:crypto";
import {
  badRequest,
  forbidden,
  isApiError,
  providerDeleted,
} from "@vm0/api-services/errors";
import { cancelRun } from "../../../../../src/lib/zero/zero-run-cancel";
import { dispatchCancelSideEffects } from "../../../../../src/lib/infra/run/run-service";
import {
  dispatchQueuedZeroRun,
  drainOrgQueue,
} from "../../../../../src/lib/zero/zero-run-queue-service";
import { processOrgUsageEvents } from "../../../../../src/lib/zero/credit/usage-event-service";
import { getModelProviderById } from "../../../../../src/lib/zero/model-provider/model-provider-service";
import {
  isModelFirstModelProviderEnabled,
  resolveModelFirstRouteDescriptor,
  type ModelFirstRouteDescriptor,
} from "../../../../../src/lib/zero/model-policy/model-first-route-service";
import { updateUserModelPreference } from "../../../../../src/lib/zero/model-policy/user-model-preference-service";
import {
  createChatThread,
  getChatThread,
  updateChatThreadTitle,
} from "../../../../../src/lib/zero/chat-thread/chat-thread-service";
import {
  insertChatMessage,
  getLatestSessionIdForThread,
  getLatestMessagesByThreadId,
  getIncompleteRoundsSinceLastSuccess,
  publishThreadListChanged,
  PREVIOUS_CONTEXT_MESSAGES,
} from "../../../../../src/lib/zero/chat-thread/chat-message-service";
import {
  generateChatTitle,
  isLightweightModelConfigured,
} from "../../../../../src/lib/zero/ai/lightweight-model";
import {
  getApiUrl,
  generateCallbackSecret,
} from "../../../../../src/lib/infra/callback";
import type { ChatCallbackPayload } from "../../../../../src/lib/infra/callback/callback-payloads";
import { publishUserSignal } from "../../../../../src/lib/infra/realtime/client";
import { logger } from "../../../../../src/lib/shared/logger";
import {
  recordChatSpan,
  recordSandboxOperation,
  type ChatSpanDimensions,
} from "../../../../../src/lib/infra/metrics";
import {
  CHAT_REQUEST_OPS,
  timed,
} from "../../../../../src/lib/zero/chat-thread/request-span-ops";
import { isPrivateAgent } from "../../../../../src/lib/zero/agent-visibility";

const log = logger("zero:chat-messages");

function createAgentAccessErrorResponse(
  agent: Awaited<ReturnType<typeof fetchZeroAgentForRun>>,
  userId: string,
) {
  if (!agent) {
    return {
      status: 404 as const,
      body: {
        error: { message: "Agent not found", code: "NOT_FOUND" as const },
      },
    };
  }
  if (!isPrivateAgent(agent) || agent.owner === userId) return null;
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Only the private agent owner can run this agent",
        code: "FORBIDDEN" as const,
      },
    },
  };
}

function assertAgentForRun(
  agent: Awaited<ReturnType<typeof fetchZeroAgentForRun>>,
): asserts agent is NonNullable<
  Awaited<ReturnType<typeof fetchZeroAgentForRun>>
> {
  if (!agent) throw new Error("Agent access check did not return a response");
}

const GOAL_DEFAULT_BUDGET = 10;

function buildAppendSystemPrompt(
  incompleteContext: string,
  goalContext: WebChatGoalContext | null,
): string {
  return [
    buildWebChatPrompt(),
    goalContext ? buildWebChatGoalPrompt(goalContext) : "",
    incompleteContext,
  ]
    .filter((part) => {
      return typeof part === "string" && part.length > 0;
    })
    .join("\n\n");
}

interface GoalOriginRow {
  messageId: string;
  remainingTurns: number;
}

interface GoalSetup {
  goalContext: WebChatGoalContext | null;
  goalOriginRow: GoalOriginRow | null;
}

const GOAL_OFF: GoalSetup = { goalContext: null, goalOriginRow: null };

function extractEmail(
  claims: { email?: string } | undefined,
): string | undefined {
  return claims ? claims.email : undefined;
}

interface DispatchInsertGoalParams {
  id: string | undefined;
  goalRemainingTurns: number | null;
  goalOriginMessageId: string | null;
}

/**
 * Resolve the columns the dispatch-path `insertChatMessage` call needs to
 * stamp on the user row: id (mints the self-FK origin when in goal mode,
 * otherwise reuses the client-supplied uuid), and the two goal columns.
 * Pulling this out of the `send` body keeps the route handler under the
 * cyclomatic-complexity cap.
 */
function buildDispatchInsertGoalParams(
  goalOriginRow: GoalOriginRow | null,
  clientMessageId: string | undefined,
): DispatchInsertGoalParams {
  if (!goalOriginRow) {
    return {
      id: clientMessageId,
      goalRemainingTurns: null,
      goalOriginMessageId: null,
    };
  }
  return {
    id: goalOriginRow.messageId,
    goalRemainingTurns: goalOriginRow.remainingTurns,
    goalOriginMessageId: goalOriginRow.messageId,
  };
}

/**
 * Resolve goal-mode setup for a `send` request. Returns the empty setup when
 * the body did not request goal mode; otherwise validates the feature switch
 * (throwing 403 via `forbidden()` if disabled) and mints the origin message
 * id used for the self-FK on `goal_origin_message_id`.
 */
async function resolveGoalSetup(
  body: { goal?: boolean; clientMessageId?: string },
  caller: { userId: string; email: string | undefined; orgId: string },
): Promise<GoalSetup> {
  if (body.goal !== true) {
    return GOAL_OFF;
  }
  const overrides = await loadFeatureSwitchOverrides(
    caller.orgId,
    caller.userId,
  );
  const enabled = isFeatureEnabled(FeatureSwitchKey.Goal, {
    userId: caller.userId,
    email: caller.email,
    orgId: caller.orgId,
    overrides,
  });
  if (!enabled) {
    throw forbidden("Goal mode is not available for this account");
  }
  const messageId = body.clientMessageId ?? randomUUID();
  return {
    goalContext: { remainingTurns: GOAL_DEFAULT_BUDGET },
    goalOriginRow: { messageId, remainingTurns: GOAL_DEFAULT_BUDGET },
  };
}

/**
 * Build the full prompt including file descriptions appended after user text.
 */
function buildFullPrompt(
  prompt: string,
  attachFiles: AttachFile[] | undefined,
): string {
  if (!attachFiles || attachFiles.length === 0) return prompt;
  return `${prompt}\n\n${buildWebAttachFilesPrompt(attachFiles)}`;
}

interface PreloadedOrgMetadataForRun {
  orgId: string;
  tier: string;
  credits?: number;
}

function buildPreloadedOrgMetadata(params: {
  org: { orgId: string; tier: string };
  orgMeta: { credits: number } | undefined;
}): PreloadedOrgMetadataForRun {
  if (!params.orgMeta) {
    return {
      orgId: params.org.orgId,
      tier: params.org.tier,
    };
  }
  return {
    orgId: params.org.orgId,
    tier: params.org.tier,
    credits: params.orgMeta.credits,
  };
}

interface ResolvedThread {
  threadId: string;
  sessionId: string | undefined;
  incompleteContext: string;
  isNewThread: boolean;
}

async function activeRunExistsForThread(threadId: string): Promise<boolean> {
  const [run] = await globalThis.services.db
    .select({ id: zeroRuns.id })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(
      and(
        eq(zeroRuns.chatThreadId, threadId),
        inArray(agentRuns.status, ["queued", "pending", "running"]),
      ),
    )
    .limit(1);
  return run !== undefined;
}

async function appendUnassociatedUserMessage(params: {
  threadId: string;
  userId: string;
  prompt: string;
  attachFiles: AttachFile[] | undefined;
  clientMessageId: string | undefined;
  /**
   * When set, the row is marked as a goal-mode origin: `goalRemainingTurns`
   * carries the budget and `goalOriginMessageId` self-references the row id.
   * The id is generated up-front (or reused from clientMessageId) so the
   * self-FK lands in a single insert.
   */
  goalOrigin: { messageId: string; remainingTurns: number } | null;
}): Promise<{ createdAt: Date }> {
  return globalThis.services.db.transaction(async (tx) => {
    await tx
      .update(chatThreads)
      .set({
        draftContent: null,
        draftAttachments: null,
      })
      .where(
        and(
          eq(chatThreads.id, params.threadId),
          eq(chatThreads.userId, params.userId),
        ),
      );

    const attachFileIds = params.attachFiles?.map((file) => {
      return file.id;
    });

    const explicitId = params.goalOrigin?.messageId ?? params.clientMessageId;

    const inserted = await tx
      .insert(chatMessages)
      .values({
        ...(explicitId ? { id: explicitId } : {}),
        chatThreadId: params.threadId,
        role: "user",
        content: params.prompt,
        runId: null,
        attachFiles:
          attachFileIds && attachFileIds.length > 0 ? attachFileIds : null,
        goalRemainingTurns: params.goalOrigin?.remainingTurns ?? null,
        goalOriginMessageId: params.goalOrigin?.messageId ?? null,
      })
      .onConflictDoNothing({ target: chatMessages.id })
      .returning({ createdAt: chatMessages.createdAt });

    const [insertedMessage] = inserted;
    if (insertedMessage) {
      return insertedMessage;
    }

    if (!explicitId) {
      throw new Error("Failed to insert unassociated user message");
    }

    const [existing] = await tx
      .select({ createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.chatThreadId))
      .where(
        and(
          eq(chatMessages.id, explicitId),
          eq(chatMessages.chatThreadId, params.threadId),
          eq(chatThreads.userId, params.userId),
          eq(chatMessages.role, "user"),
          isNull(chatMessages.runId),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new Error("Failed to resolve unassociated user message");
    }
    return existing;
  });
}

async function appendRecallUserMessage(params: {
  threadId: string;
  userId: string;
  revokesMessageId: string;
  clientMessageId: string | undefined;
}): Promise<{ id: string; createdAt: Date }> {
  return globalThis.services.db.transaction(async (tx) => {
    const [existingRevoker] = await tx
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        runId: chatMessages.runId,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, params.threadId),
          eq(chatMessages.revokesMessageId, params.revokesMessageId),
        ),
      )
      .limit(1);

    if (existingRevoker) {
      if (existingRevoker.role === "user" && existingRevoker.runId === null) {
        return { id: existingRevoker.id, createdAt: existingRevoker.createdAt };
      }
      throw badRequest("Only queued user messages can be recalled");
    }

    const [target] = await tx
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.id, params.revokesMessageId),
          eq(chatMessages.chatThreadId, params.threadId),
          eq(chatMessages.role, "user"),
          isNull(chatMessages.runId),
          isNull(chatMessages.revokesMessageId),
        ),
      )
      .limit(1);

    if (!target) {
      throw badRequest("Only queued user messages can be recalled");
    }

    const [inserted] = await tx
      .insert(chatMessages)
      .values({
        ...(params.clientMessageId ? { id: params.clientMessageId } : {}),
        chatThreadId: params.threadId,
        role: "user",
        content: null,
        runId: null,
        revokesMessageId: params.revokesMessageId,
        attachFiles: null,
      })
      .onConflictDoNothing()
      .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });

    if (inserted) {
      return inserted;
    }

    const [resolved] = await tx
      .select({ id: chatMessages.id, createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, params.threadId),
          eq(chatMessages.revokesMessageId, params.revokesMessageId),
          eq(chatMessages.role, "user"),
          isNull(chatMessages.runId),
        ),
      )
      .limit(1);

    if (!resolved) {
      throw new Error("Failed to insert recall user message");
    }
    return resolved;
  });
}

async function appendInterruptUserMessage(params: {
  threadId: string;
  interruptsRunId: string;
  clientMessageId: string | undefined;
}): Promise<{ id: string; createdAt: Date }> {
  return globalThis.services.db.transaction(async (tx) => {
    const [existingInterrupter] = await tx
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        runId: chatMessages.runId,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, params.threadId),
          eq(chatMessages.interruptsRunId, params.interruptsRunId),
        ),
      )
      .limit(1);

    if (existingInterrupter) {
      if (
        existingInterrupter.role === "user" &&
        existingInterrupter.runId === null
      ) {
        return {
          id: existingInterrupter.id,
          createdAt: existingInterrupter.createdAt,
        };
      }
      throw badRequest("Only active chat runs can be interrupted");
    }

    const [targetRun] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .where(
        and(
          eq(agentRuns.id, params.interruptsRunId),
          eq(zeroRuns.chatThreadId, params.threadId),
          inArray(agentRuns.status, ["queued", "pending", "running"]),
        ),
      )
      .limit(1);

    if (!targetRun) {
      throw badRequest("Only active chat runs can be interrupted");
    }

    const [inserted] = await tx
      .insert(chatMessages)
      .values({
        ...(params.clientMessageId ? { id: params.clientMessageId } : {}),
        chatThreadId: params.threadId,
        role: "user",
        content: null,
        runId: null,
        interruptsRunId: params.interruptsRunId,
        attachFiles: null,
      })
      .onConflictDoNothing()
      .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });

    if (inserted) {
      return inserted;
    }

    const [resolved] = await tx
      .select({ id: chatMessages.id, createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, params.threadId),
          eq(chatMessages.interruptsRunId, params.interruptsRunId),
          eq(chatMessages.role, "user"),
          isNull(chatMessages.runId),
        ),
      )
      .limit(1);

    if (!resolved) {
      throw new Error("Failed to insert interrupt user message");
    }
    return resolved;
  });
}

interface ThreadModelPin {
  modelProviderId: string | null;
  modelProviderType: string | null;
  modelProviderCredentialScope: string | null;
  selectedModel: string | null;
}

interface ResolvedThreadModelPin extends ThreadModelPin {
  explicitModelFirstModelSelection: boolean;
}

function pinFromModelFirstRoute(
  route: ModelFirstRouteDescriptor,
): ThreadModelPin {
  return {
    modelProviderId: route.modelProviderId,
    modelProviderType: route.providerType,
    modelProviderCredentialScope: route.credentialScope,
    selectedModel: route.selectedModel,
  };
}

function resolvedPin(
  pin: ThreadModelPin,
  explicitModelFirstModelSelection = false,
): ResolvedThreadModelPin {
  return {
    ...pin,
    explicitModelFirstModelSelection,
  };
}

async function getStoredThreadModelPin(
  threadId: string,
): Promise<ThreadModelPin | null> {
  const [thread] = await globalThis.services.db
    .select({
      modelProviderId: chatThreads.modelProviderId,
      modelProviderType: chatThreads.modelProviderType,
      modelProviderCredentialScope: chatThreads.modelProviderCredentialScope,
      selectedModel: chatThreads.selectedModel,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!thread || thread.selectedModel === null) {
    return null;
  }
  return thread;
}

async function getFirstRunModelPin(
  threadId: string,
): Promise<ThreadModelPin | null> {
  const [run] = await globalThis.services.db
    .select({
      modelProviderId: zeroRuns.modelProviderId,
      modelProviderType: zeroRuns.modelProvider,
      modelProviderCredentialScope: zeroRuns.modelProviderCredentialScope,
      selectedModel: zeroRuns.selectedModel,
    })
    .from(chatMessages)
    .innerJoin(zeroRuns, eq(zeroRuns.id, chatMessages.runId))
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        eq(chatMessages.role, "user"),
        isNotNull(chatMessages.runId),
        isNotNull(zeroRuns.selectedModel),
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    .limit(1);
  if (!run?.selectedModel) {
    return null;
  }
  return run;
}

async function getExistingModelFirstThreadPin(
  threadId: string,
): Promise<ThreadModelPin | null> {
  return (
    (await getStoredThreadModelPin(threadId)) ??
    (await getFirstRunModelPin(threadId))
  );
}

async function persistModelFirstThreadPinIfUnset(
  threadId: string,
  pin: ThreadModelPin,
): Promise<ThreadModelPin> {
  if (!pin.selectedModel) {
    return pin;
  }

  const [updated] = await globalThis.services.db
    .update(chatThreads)
    .set({
      modelProviderId: pin.modelProviderId,
      modelProviderType: pin.modelProviderType,
      modelProviderCredentialScope: pin.modelProviderCredentialScope,
      selectedModel: pin.selectedModel,
      updatedAt: new Date(),
    })
    .where(and(eq(chatThreads.id, threadId), isNull(chatThreads.selectedModel)))
    .returning({
      modelProviderId: chatThreads.modelProviderId,
      modelProviderType: chatThreads.modelProviderType,
      modelProviderCredentialScope: chatThreads.modelProviderCredentialScope,
      selectedModel: chatThreads.selectedModel,
    });
  return updated ?? (await getStoredThreadModelPin(threadId)) ?? pin;
}

async function resolveStoredModelFirstPin(params: {
  orgId: string;
  userId: string;
  pin: ThreadModelPin;
}): Promise<ThreadModelPin> {
  const route = await resolveModelFirstRouteDescriptor({
    orgId: params.orgId,
    userId: params.userId,
    selectedModel: params.pin.selectedModel,
    providerType: params.pin.modelProviderType ?? undefined,
    credentialScope: params.pin.modelProviderCredentialScope ?? undefined,
    modelProviderId: params.pin.modelProviderId ?? undefined,
  });
  return pinFromModelFirstRoute(route);
}

/**
 * Persist the composer's per-run override onto the thread row and return the
 * effective override to use for this run (legacy precedence: per-run > thread
 * > agent). Model-first pins the first effective user-message model to the
 * thread so later sends do not drift with the user's current model preference.
 * `null` or `undefined` for `modelSelection` means "inherit" — older clients
 * that never saw the field and newer clients explicitly choosing "Use default"
 * both get the thread/agent fall-through.
 *
 * When the thread carries an eager-pinned provider but that provider has since
 * been deleted, this throws `providerDeleted()` rather than silently falling
 * back to the agent's current provider — the user must start a new thread to
 * pick a different model.
 */
async function resolveRunModelOverride(
  orgId: string,
  userId: string,
  threadId: string,
  agent: { modelProviderId: string | null; selectedModel: string | null },
  modelFirstEnabled: boolean,
  modelSelection:
    | { modelProviderId: string; selectedModel: string }
    | null
    | undefined,
): Promise<ResolvedThreadModelPin> {
  if (modelSelection !== undefined && modelSelection !== null) {
    if (modelFirstEnabled) {
      const storedPin = await getExistingModelFirstThreadPin(threadId);
      if (storedPin) {
        const pin = await persistModelFirstThreadPinIfUnset(
          threadId,
          await resolveStoredModelFirstPin({ orgId, userId, pin: storedPin }),
        );
        return resolvedPin(pin, true);
      }

      const route = await resolveModelFirstRouteDescriptor({
        orgId,
        userId,
        selectedModel: modelSelection.selectedModel,
      });
      const pin = await persistModelFirstThreadPinIfUnset(
        threadId,
        pinFromModelFirstRoute(route),
      );
      return resolvedPin(pin, true);
    }

    await globalThis.services.db
      .update(chatThreads)
      .set({
        modelProviderId: modelSelection.modelProviderId,
        modelProviderType: null,
        modelProviderCredentialScope: null,
        selectedModel: modelSelection.selectedModel,
        updatedAt: new Date(),
      })
      .where(eq(chatThreads.id, threadId));
    return resolvedPin({
      modelProviderId: modelSelection.modelProviderId,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: modelSelection.selectedModel,
    });
  } else {
    if (modelFirstEnabled) {
      const storedPin = await getExistingModelFirstThreadPin(threadId);
      if (storedPin) {
        const resolvedStoredPin = await resolveStoredModelFirstPin({
          orgId,
          userId,
          pin: storedPin,
        });
        const pin = await persistModelFirstThreadPinIfUnset(
          threadId,
          resolvedStoredPin,
        );
        return resolvedPin(pin, true);
      }

      const route = await resolveModelFirstRouteDescriptor({ orgId, userId });
      const pin = await persistModelFirstThreadPinIfUnset(
        threadId,
        pinFromModelFirstRoute(route),
      );
      return resolvedPin(pin, true);
    }

    const [thread] = await globalThis.services.db
      .select({
        modelProviderId: chatThreads.modelProviderId,
        modelProviderType: chatThreads.modelProviderType,
        modelProviderCredentialScope: chatThreads.modelProviderCredentialScope,
        selectedModel: chatThreads.selectedModel,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .limit(1);
    if (thread?.modelProviderId && thread.selectedModel) {
      const provider = await getModelProviderById(
        orgId,
        userId,
        thread.modelProviderId,
      );
      if (!provider) {
        throw providerDeleted();
      }
      return resolvedPin({
        modelProviderId: thread.modelProviderId,
        modelProviderType: null,
        modelProviderCredentialScope: null,
        selectedModel: thread.selectedModel,
      });
    }
  }

  return resolvedPin({
    modelProviderId: agent.modelProviderId,
    modelProviderType: null,
    modelProviderCredentialScope: null,
    selectedModel: agent.selectedModel,
  });
}

/**
 * Once a thread has stored modelProviderId + selectedModel, those values are
 * immutable. The picker is disabled on existing threads, so this guard
 * rejects out-of-band/manual API callers that try to change or clear them.
 */
async function rejectIfThreadModelLocked(
  threadId: string,
  incoming: { modelProviderId: string; selectedModel: string } | null,
  modelFirstEnabled: boolean,
): Promise<boolean> {
  if (modelFirstEnabled) {
    const existingPin = await getExistingModelFirstThreadPin(threadId);
    if (!existingPin?.selectedModel) {
      return false;
    }
    return (
      incoming === null || existingPin.selectedModel !== incoming.selectedModel
    );
  }

  const [existing] = await globalThis.services.db
    .select({
      modelProviderId: chatThreads.modelProviderId,
      modelProviderType: chatThreads.modelProviderType,
      selectedModel: chatThreads.selectedModel,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!existing || existing.selectedModel === null) {
    return false;
  }
  if (incoming === null) {
    return true;
  }
  return (
    existing.modelProviderId !== incoming.modelProviderId ||
    existing.selectedModel !== incoming.selectedModel
  );
}

async function computeEagerPin(
  orgId: string,
  userId: string,
  agent: {
    modelProviderId: string | null;
    selectedModel: string | null;
  },
  modelFirstEnabled: boolean,
): Promise<ThreadModelPin> {
  if (modelFirstEnabled) {
    return {
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: null,
    };
  }

  return {
    modelProviderId: agent.modelProviderId,
    modelProviderType: null,
    modelProviderCredentialScope: null,
    selectedModel: agent.selectedModel,
  };
}

type IncomingModelSelection =
  | { modelProviderId: string; selectedModel: string }
  | null
  | undefined;

function modelSelectionBadRequest(message: string) {
  return {
    status: 400 as const,
    body: {
      error: {
        message,
        code: "BAD_REQUEST" as const,
      },
    },
  };
}

async function validateLegacyModelSelectionOwnership(params: {
  orgId: string;
  modelSelection: IncomingModelSelection;
  modelFirstEnabled: boolean;
  emit: (op: string, ms: number) => void;
}) {
  if (!params.modelSelection || params.modelFirstEnabled) return undefined;

  const modelSelection = params.modelSelection;
  const validateT = await timed(async () => {
    return globalThis.services.db
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.id, modelSelection.modelProviderId),
          eq(modelProviders.orgId, params.orgId),
        ),
      )
      .limit(1);
  });
  params.emit(CHAT_REQUEST_OPS.model_selection_validate, validateT.ms);
  const [provider] = validateT.result;
  if (provider) return undefined;
  return modelSelectionBadRequest("Unknown model provider for this workspace");
}

async function validateThreadModelSelectionLock(params: {
  threadId: string | undefined;
  modelSelection: IncomingModelSelection;
  modelFirstEnabled: boolean;
  emit: (op: string, ms: number) => void;
}) {
  const { threadId, modelSelection } = params;
  if (threadId === undefined || modelSelection === undefined) {
    return undefined;
  }

  const lockT = await timed(async () => {
    return rejectIfThreadModelLocked(
      threadId,
      modelSelection,
      params.modelFirstEnabled,
    );
  });
  params.emit(CHAT_REQUEST_OPS.model_selection_lock_check, lockT.ms);
  if (!lockT.result) return undefined;
  return modelSelectionBadRequest("Cannot change model on an existing thread");
}

async function validateSendModelSelection(params: {
  orgId: string;
  threadId: string | undefined;
  modelSelection: IncomingModelSelection;
  modelFirstEnabled: boolean;
  emit: (op: string, ms: number) => void;
}) {
  const ownershipError = await validateLegacyModelSelectionOwnership({
    orgId: params.orgId,
    modelSelection: params.modelSelection,
    modelFirstEnabled: params.modelFirstEnabled,
    emit: params.emit,
  });
  if (ownershipError) return ownershipError;

  return validateThreadModelSelectionLock({
    threadId: params.threadId,
    modelSelection: params.modelSelection,
    modelFirstEnabled: params.modelFirstEnabled,
    emit: params.emit,
  });
}

function hasExplicitModelFirstSelection(
  modelFirstEnabled: boolean,
  modelSelection: IncomingModelSelection,
): modelSelection is { modelProviderId: string; selectedModel: string } {
  return (
    modelFirstEnabled && modelSelection !== undefined && modelSelection !== null
  );
}

async function persistExplicitModelFirstSelection(params: {
  orgId: string;
  userId: string;
  threadId: string;
  modelFirstEnabled: boolean;
  modelSelection: IncomingModelSelection;
}): Promise<boolean> {
  if (
    !hasExplicitModelFirstSelection(
      params.modelFirstEnabled,
      params.modelSelection,
    )
  ) {
    return false;
  }
  const existingPin = await getExistingModelFirstThreadPin(params.threadId);
  if (existingPin) {
    return false;
  }
  await updateUserModelPreference(
    params.orgId,
    params.userId,
    params.modelSelection.selectedModel,
  );
  return true;
}

function shouldHonorModelFirstSelectionOverride(params: {
  persistedExplicitSelection: boolean;
  override: ResolvedThreadModelPin;
}): boolean {
  return (
    params.persistedExplicitSelection ||
    params.override.explicitModelFirstModelSelection
  );
}

/**
 * Resolve an existing thread or create a new one.
 * Returns thread metadata needed for run creation and title generation.
 *
 * When `dims` is provided, each sub-stage (create-thread, get-thread,
 * session-id lookup, and incomplete-rounds)
 * emits a span to the `sandbox-op-log` Axiom dataset with
 * `source: "web-chat"`. Each parallel arm is wrapped in `timed()` so the
 * per-query duration is still captured alongside the parallel execution.
 */
async function resolveThread(
  userId: string,
  agentId: string,
  existingThreadId: string | undefined,
  clientThreadId: string | undefined,
  agentPin: ThreadModelPin,
  dims?: ChatSpanDimensions,
): Promise<ResolvedThread> {
  const emit = (op: string, ms: number): void => {
    if (dims) recordChatSpan(op, ms, dims);
  };

  if (!existingThreadId) {
    const createT = await timed(async () => {
      return createChatThread(userId, agentId, null, clientThreadId, agentPin);
    });
    emit(CHAT_REQUEST_OPS.resolve_thread_create_thread, createT.ms);
    const thread = createT.result;
    if (dims) {
      dims.thread_id = thread.id;
      dims.thread_is_new = true;
    }
    return {
      threadId: thread.id,
      sessionId: undefined,
      incompleteContext: "",
      isNewThread: true,
    };
  }

  // Three independent reads keyed off `(existingThreadId, userId)`. Running
  // them in parallel caps wall time at the slowest arm. The prior 4th arm
  // (`getLatestMessagesByThreadId`) was a ~275ms P50 read used only by the
  // fire-and-forget title generator — now lifted off this critical path.
  const [threadT, sessionIdT, incompleteT] = await Promise.all([
    timed(async () => {
      return getChatThread(existingThreadId, userId);
    }),
    timed(async () => {
      return getLatestSessionIdForThread(existingThreadId);
    }),
    timed(async () => {
      return getIncompleteRoundsSinceLastSuccess(existingThreadId);
    }),
  ]);
  emit(CHAT_REQUEST_OPS.resolve_thread_get_thread, threadT.ms);
  emit(CHAT_REQUEST_OPS.resolve_thread_session_id, sessionIdT.ms);
  emit(CHAT_REQUEST_OPS.resolve_thread_incomplete, incompleteT.ms);

  const thread = threadT.result;
  const sessionId = sessionIdT.result;

  if (dims) {
    dims.thread_id = thread.id;
    dims.thread_is_new = false;
  }

  const incompleteContext = buildWebChatIncompleteContext(
    groupIncompleteRoundsByRunId(incompleteT.result),
  );

  return {
    threadId: thread.id,
    sessionId,
    incompleteContext,
    isNewThread: false,
  };
}

/**
 * Collapse the flat chronological rows from `getIncompleteRoundsSinceLastSuccess`
 * into per-run groups. Row order is preserved so the user message (inserted on
 * send with no `sequence_number`) stays ahead of any assistant event rows.
 */
function groupIncompleteRoundsByRunId(
  rows: Awaited<ReturnType<typeof getIncompleteRoundsSinceLastSuccess>>,
): WebChatIncompleteRound[] {
  const byRunId = new Map<string, WebChatIncompleteRound>();
  const order: string[] = [];
  for (const row of rows) {
    let round = byRunId.get(row.runId);
    if (!round) {
      round = {
        runId: row.runId,
        status: row.runStatus,
        messages: [],
      };
      byRunId.set(row.runId, round);
      order.push(row.runId);
    }
    round.messages.push({
      role: row.role,
      content: row.content,
      error: row.error,
      attachFiles: row.attachFiles,
    });
  }
  return order.map((id) => {
    return byRunId.get(id)!;
  });
}

interface RecallSendBody {
  agentId: string;
  threadId: string;
  revokesMessageId: string;
  clientMessageId?: string;
}

function isRecallSendBody(body: {
  revokesMessageId?: string;
}): body is RecallSendBody {
  return body.revokesMessageId !== undefined;
}

interface InterruptSendBody {
  agentId: string;
  threadId: string;
  interruptsRunId: string;
  clientMessageId?: string;
}

function isInterruptSendBody(body: {
  interruptsRunId?: string;
}): body is InterruptSendBody {
  return body.interruptsRunId !== undefined;
}

async function handleRecallSend(
  body: RecallSendBody,
  authorization: string | undefined,
) {
  const authCtx = await requireAuth(authorization, {
    requiredCapability: "agent-run:write",
  });
  if (isAuthError(authCtx)) return authCtx;

  await getChatThread(body.threadId, authCtx.userId);
  const message = await appendRecallUserMessage({
    threadId: body.threadId,
    userId: authCtx.userId,
    revokesMessageId: body.revokesMessageId,
    clientMessageId: body.clientMessageId,
  });
  await publishUserSignal(
    [authCtx.userId],
    `chatThreadMessageCreated:${body.threadId}`,
  );
  await publishThreadListChanged(authCtx.userId);
  return {
    status: 201 as const,
    body: {
      runId: null,
      threadId: body.threadId,
      createdAt: message.createdAt.toISOString(),
    },
  };
}

async function handleInterruptSend(
  body: InterruptSendBody,
  authorization: string | undefined,
) {
  const authCtx = await requireAuth(authorization, {
    requiredCapability: "agent-run:write",
  });
  if (isAuthError(authCtx)) return authCtx;

  await getChatThread(body.threadId, authCtx.userId);
  const { org } = await resolveOrgWithMetadata(authCtx);
  const message = await appendInterruptUserMessage({
    threadId: body.threadId,
    interruptsRunId: body.interruptsRunId,
    clientMessageId: body.clientMessageId,
  });
  await publishUserSignal(
    [authCtx.userId],
    `chatThreadMessageCreated:${body.threadId}`,
  );
  await publishThreadListChanged(authCtx.userId);

  const result = await cancelRun(
    body.interruptsRunId,
    authCtx.userId,
    org.orgId,
  );

  if (!result.alreadyCancelled) {
    after(async () => {
      const shouldProcessCredits = await dispatchCancelSideEffects(
        result,
        (orgId) => {
          return drainOrgQueue(orgId, dispatchQueuedZeroRun);
        },
      );
      if (shouldProcessCredits) {
        await processOrgUsageEvents(result.orgId);
      }
    });
  }

  return {
    status: 201 as const,
    body: {
      runId: null,
      threadId: body.threadId,
      createdAt: message.createdAt.toISOString(),
    },
  };
}

async function handleControlSend(
  body: { revokesMessageId?: string; interruptsRunId?: string },
  authorization: string | undefined,
) {
  if (isRecallSendBody(body)) {
    return handleRecallSend(body, authorization);
  }
  if (isInterruptSendBody(body)) {
    return handleInterruptSend(body, authorization);
  }
  return undefined;
}

function requirePrompt(body: { prompt?: string }): string {
  if (body.prompt === undefined) {
    throw badRequest("Prompt is required");
  }
  return body.prompt;
}

const router = tsr.router(chatMessagesContract, {
  send: async ({ body, headers }) => {
    const apiStartTime = Date.now();
    initServices();

    const controlResponse = await handleControlSend(
      body,
      headers.authorization,
    );
    if (controlResponse) {
      return controlResponse;
    }
    const prompt = requirePrompt(body);

    // Dims object is mutated in place as details become known. Each Phase-1
    // sub-stage emits a span carrying the dims snapshot at emit time.
    // `run_id` and `org_id` are stamped later inside createZeroRunRecord.
    const dims: ChatSpanDimensions = {
      agent_id: body.agentId,
      model_selection_present: body.modelSelection != null,
    };
    const emit = (op: string, ms: number): void => {
      recordChatSpan(op, ms, dims);
    };

    const authT = await timed(async () => {
      return requireAuth(headers.authorization, {
        requiredCapability: "agent-run:write",
      });
    });
    emit(CHAT_REQUEST_OPS.auth, authT.ms);
    const authCtx = authT.result;
    if (isAuthError(authCtx)) return authCtx;
    dims.user_id = authCtx.userId;
    dims.token_type = authCtx.tokenType;

    // Verify agent exists and fetch the union projection (404 check + model
    // override fields here; full row passed through to createZeroRun so the
    // service's Round 1 skips its duplicate SELECT).
    const agentT = await timed(async () => {
      return fetchZeroAgentForRun(body.agentId);
    });
    emit(CHAT_REQUEST_OPS.agent_lookup, agentT.ms);
    const agent = agentT.result;

    const agentAccessError = createAgentAccessErrorResponse(
      agent,
      authCtx.userId,
    );
    if (agentAccessError) return agentAccessError;
    assertAgentForRun(agent);

    // resolveOrgWithMetadata already fetches org_metadata — capture the tier
    // and DB-backed credits here so createZeroRun can skip duplicate reads.
    // Resolved up front (rather than only inside the modelSelection branch) so
    // the orphan-pin detection in resolveRunModelOverride can scope its
    // provider lookup to the caller's org.
    const { org: callerOrg, orgMeta: callerOrgMeta } =
      await resolveOrgWithMetadata(authCtx);

    const { goalContext, goalOriginRow } = await resolveGoalSetup(body, {
      userId: authCtx.userId,
      email: extractEmail(authCtx.sessionClaims),
      orgId: callerOrg.orgId,
    });

    const preloadedOrgMetadata = buildPreloadedOrgMetadata({
      org: callerOrg,
      orgMeta: callerOrgMeta,
    });
    const modelFirstEnabled = await isModelFirstModelProviderEnabled(
      callerOrg.orgId,
      authCtx.userId,
    );

    const modelSelectionError = await validateSendModelSelection({
      orgId: callerOrg.orgId,
      threadId: body.threadId,
      modelSelection: body.modelSelection,
      modelFirstEnabled,
      emit,
    });
    if (modelSelectionError) return modelSelectionError;

    try {
      // Existing-thread sends pass the agent's pin literally — `resolveThread`
      // does not use it on that branch because it reads the persisted pin.
      // New threads persist the current agent/model-first pin at creation time.
      const eagerPin = body.threadId
        ? {
            modelProviderId: agent.modelProviderId,
            modelProviderType: null,
            modelProviderCredentialScope: null,
            selectedModel: agent.selectedModel,
          }
        : await computeEagerPin(
            callerOrg.orgId,
            authCtx.userId,
            {
              modelProviderId: agent.modelProviderId,
              selectedModel: agent.selectedModel,
            },
            modelFirstEnabled,
          );
      const { threadId, sessionId, incompleteContext, isNewThread } =
        await resolveThread(
          authCtx.userId,
          body.agentId,
          body.threadId,
          body.clientThreadId,
          eagerPin,
          dims,
        );

      const persistedExplicitModelFirstSelection =
        await persistExplicitModelFirstSelection({
          orgId: callerOrg.orgId,
          userId: authCtx.userId,
          threadId,
          modelFirstEnabled,
          modelSelection: body.modelSelection,
        });

      if (await activeRunExistsForThread(threadId)) {
        const message = await appendUnassociatedUserMessage({
          threadId,
          userId: authCtx.userId,
          prompt,
          attachFiles: body.attachFiles,
          clientMessageId: body.clientMessageId,
          goalOrigin: goalOriginRow,
        });
        await publishUserSignal(
          [authCtx.userId],
          `chatThreadMessageCreated:${threadId}`,
        );
        await publishThreadListChanged(authCtx.userId);
        return {
          status: 201 as const,
          body: {
            runId: null,
            threadId,
            createdAt: message.createdAt.toISOString(),
          },
        };
      }

      const overrideT = await timed(async () => {
        return resolveRunModelOverride(
          callerOrg.orgId,
          authCtx.userId,
          threadId,
          {
            modelProviderId: agent.modelProviderId,
            selectedModel: agent.selectedModel,
          },
          modelFirstEnabled,
          body.modelSelection,
        );
      });
      emit(CHAT_REQUEST_OPS.resolve_model_override, overrideT.ms);
      const override = overrideT.result;
      const explicitModelFirstModelSelection =
        shouldHonorModelFirstSelectionOverride({
          persistedExplicitSelection: persistedExplicitModelFirstSelection,
          override,
        });

      // Only generate title when prompt has actual user text. The
      // assistant reply is not yet available at send time — the chat
      // callback regenerates the title with the full current exchange
      // once the run completes.
      //
      // Title generation is non-critical. Keep it out of the response path
      // and do not schedule the DB context fetch when the lightweight model is
      // unavailable (common in tests and local dev).
      if (body.hasTextContent !== false && isLightweightModelConfigured()) {
        after(async () => {
          let priorRounds:
            | { role: "user" | "assistant"; content: string }[]
            | undefined;
          try {
            if (!isNewThread) {
              const fetchT = await timed(async () => {
                return getLatestMessagesByThreadId(
                  threadId,
                  PREVIOUS_CONTEXT_MESSAGES,
                );
              });
              recordChatSpan(
                CHAT_REQUEST_OPS.title_context_fetch,
                fetchT.ms,
                dims,
              );
              const mapped = fetchT.result.map((m) => {
                return { role: m.role, content: m.content };
              });
              priorRounds = mapped.length > 0 ? mapped : undefined;
            }
            const title = await generateChatTitle({
              currentUserMessage: prompt,
              priorRounds,
            });
            if (title) {
              await updateChatThreadTitle(threadId, authCtx.userId, title);
            }
          } catch (err: unknown) {
            log.warn("Chat title generation failed", { threadId, err });
          }
        });
      }

      // Build callback for session persistence
      const chatCallback: {
        url: string;
        secret: string;
        payload: ChatCallbackPayload;
      } = {
        url: getApiUrl() + "/api/internal/callbacks/chat",
        secret: generateCallbackSecret(),
        payload: { threadId, agentId: body.agentId },
      };

      const requestedModelProvider =
        body.modelProvider && body.modelProvider !== "default"
          ? body.modelProvider
          : undefined;
      const modelProvider =
        override.modelProviderType ?? requestedModelProvider;

      // Build prompt: user text + file descriptions appended
      const fullPrompt = buildFullPrompt(prompt, body.attachFiles);

      // Create the run. Phase 2 dispatch is deferred inside createZeroRun
      // via waitUntil() so the response flushes before tokens/secrets/runner work.
      const result = await createZeroRun({
        userId: authCtx.userId,
        prompt: fullPrompt,
        agentId: body.agentId,
        sessionId,
        triggerSource: "web",
        apiStartTime,
        modelProvider,
        modelProviderId: override.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          override.modelProviderCredentialScope ?? undefined,
        selectedModelOverride: override.selectedModel ?? undefined,
        explicitModelFirstModelSelection,
        debugNoMockClaude: body.debugNoMockClaude,
        debugNoMockCodex: body.debugNoMockCodex,
        appendSystemPrompt: buildAppendSystemPrompt(
          incompleteContext,
          goalContext,
        ),
        callbacks: [chatCallback],
        chatThreadId: threadId,
        preloadedAgent: agent,
        preloadedOrgMetadata,
        spanDims: dims,
        userProfile: userProfileFromClaims(authCtx),
      });

      // Stamp response-ready for the Phase-2 instrumentation split before
      // registering the signals waitUntil() so we can measure its closure-entry
      // offset against the same responseReady anchor used by dispatchZeroRun.
      const responseReadyAt = result.markResponseReady();

      // Persist user message to chat_messages in waitUntil() so the 201
      // response flushes before the INSERT (+ internal chatThreadMessageCreated
      // publish) runs. The response body omits the row id and the client
      // renders optimistically via clientMessageId, so no caller blocks.
      //
      // Ordering: insertChatMessage MUST complete before publishUserSignal /
      // publishThreadListChanged fire — those signals tell other devices to
      // refetch the thread list / paged-messages view, and they must see the
      // new row on refetch. The `await`s below preserve that ordering.
      const dispatchGoalParams = buildDispatchInsertGoalParams(
        goalOriginRow,
        body.clientMessageId,
      );
      waitUntil(
        (async () => {
          const signalsEnterAt = Date.now();
          try {
            // Stamp with the runId so the callback's prior-context filter can
            // exclude this message structurally (by runId) instead of by content.
            await insertChatMessage({
              chatThreadId: threadId,
              userId: authCtx.userId,
              role: "user",
              content: prompt,
              runId: result.runId,
              attachFiles: body.attachFiles?.map((f: AttachFile) => {
                return f.id;
              }),
              id: dispatchGoalParams.id,
              goalRemainingTurns: dispatchGoalParams.goalRemainingTurns,
              goalOriginMessageId: dispatchGoalParams.goalOriginMessageId,
              spanDims: dims,
            });
          } catch (err: unknown) {
            log.error("Deferred insertChatMessage failed", {
              runId: result.runId,
              err,
            });
          }
          await publishUserSignal(
            [authCtx.userId],
            `chatThreadRunCreated:${threadId}`,
          );
          await publishThreadListChanged(authCtx.userId);
          // Cross-referenced with api_after_schedule_to_closure in Axiom to
          // infer whether Vercel fires waitUntil() and after() callbacks in
          // parallel or serial: near-equal durations imply parallel, a large
          // gap implies serial.
          if (responseReadyAt !== undefined) {
            recordSandboxOperation({
              sandboxType: "chat",
              actionType: "api_after_signals_enter_offset",
              durationMs: signalsEnterAt - responseReadyAt,
              success: true,
              runId: result.runId,
            });
          }
        })(),
      );

      return {
        status: 201 as const,
        body: {
          runId: result.runId,
          threadId,
          status: result.status,
          createdAt: result.createdAt.toISOString(),
        },
      };
    } catch (error) {
      if (isApiError(error)) {
        const status = error.code === "UNAUTHORIZED" ? 404 : error.statusCode;
        const code = error.code === "UNAUTHORIZED" ? "NOT_FOUND" : error.code;
        const message =
          error.code === "UNAUTHORIZED" ? "Resource not found" : error.message;
        return {
          status: status as 400 | 401 | 403 | 404 | 422,
          body: { error: { message, code } },
        };
      }

      throw error;
    }
  },
});

const handler = createHandler(chatMessagesContract, router, {
  routeName: "zero.chat.messages",
});

export { handler as POST };
