import { and, eq } from "drizzle-orm";
import { after } from "next/server";
import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { chatMessagesContract, type AttachFile } from "@vm0/core";
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
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { modelProviders } from "../../../../../src/db/schema/model-provider";
import { chatThreads } from "../../../../../src/db/schema/chat-thread";
import {
  buildWebChatPrompt,
  buildWebAttachFilesPrompt,
  buildWebChatIncompleteContext,
  type WebChatIncompleteRound,
} from "../../../../../src/lib/zero/integration-prompt";
import { isApiError } from "../../../../../src/lib/shared/errors";
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
  hasAnyRunsForThread,
  publishThreadListChanged,
  PREVIOUS_CONTEXT_MESSAGES,
} from "../../../../../src/lib/zero/chat-thread/chat-message-service";
import { generateChatTitle } from "../../../../../src/lib/zero/ai/lightweight-model";
import { zeroRuns } from "../../../../../src/db/schema/zero-run";
import { zeroAgentSchedules } from "../../../../../src/db/schema/zero-agent-schedule";
import {
  getApiUrl,
  generateCallbackSecret,
} from "../../../../../src/lib/infra/callback";
import type { ChatCallbackPayload } from "../../../../../src/lib/infra/callback/callback-payloads";
import { publishUserSignal } from "../../../../../src/lib/infra/realtime/client";
import { logger } from "../../../../../src/lib/shared/logger";
import {
  recordChatSpan,
  type ChatSpanDimensions,
} from "../../../../../src/lib/infra/metrics";
import {
  CHAT_REQUEST_OPS,
  timed,
} from "../../../../../src/lib/zero/chat-thread/request-span-ops";

const log = logger("zero:chat-messages");

/**
 * System prompt seeded on the first run of a thread that was started from a
 * previously scheduled run. The agent can pull the original run's full
 * telemetry via the `zero logs <runId>` CLI command inside its sandbox.
 */
function buildContinueFromScheduleSystemPrompt(
  runId: string,
  scheduleName: string | null,
): string {
  const scheduleSuffix = scheduleName ? `(scheduleName: ${scheduleName})` : "";
  return (
    `You are continuing a previously scheduled run${scheduleSuffix}. ` +
    `Before replying, run \`zero logs ${runId}\` inside your sandbox to ` +
    `fetch the full record of that run, then continue the conversation with ` +
    `the user based on that context.`
  );
}

function buildAppendSystemPrompt(
  continueFromSchedulePrompt: string | undefined,
  incompleteContext: string,
): string {
  return [buildWebChatPrompt(), incompleteContext, continueFromSchedulePrompt]
    .filter((part) => {
      return typeof part === "string" && part.length > 0;
    })
    .join("\n\n");
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

interface ResolvedThread {
  threadId: string;
  sessionId: string | undefined;
  continueFromSchedulePrompt: string | undefined;
  incompleteContext: string;
  isNewThread: boolean;
}

/**
 * Persist the composer's per-run override onto the thread row and return the
 * effective override to use for this run (precedence: per-run > thread > agent).
 * `undefined` for `modelSelection` means "leave thread row as-is" — older
 * clients that never saw the field still get the thread/agent fall-through.
 */
async function resolveRunModelOverride(
  threadId: string,
  agent: { modelProviderId: string | null; selectedModel: string | null },
  modelSelection:
    | { modelProviderId: string; selectedModel: string }
    | null
    | undefined,
): Promise<{ providerId: string | null; selectedModel: string | null }> {
  if (modelSelection !== undefined && modelSelection !== null) {
    await globalThis.services.db
      .update(chatThreads)
      .set({
        modelProviderId: modelSelection.modelProviderId,
        selectedModel: modelSelection.selectedModel,
        updatedAt: new Date(),
      })
      .where(eq(chatThreads.id, threadId));
    return {
      providerId: modelSelection.modelProviderId,
      selectedModel: modelSelection.selectedModel,
    };
  } else if (modelSelection === undefined) {
    const [thread] = await globalThis.services.db
      .select({
        modelProviderId: chatThreads.modelProviderId,
        selectedModel: chatThreads.selectedModel,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .limit(1);
    if (thread?.modelProviderId && thread.selectedModel) {
      return {
        providerId: thread.modelProviderId,
        selectedModel: thread.selectedModel,
      };
    }
  }
  return {
    providerId: agent.modelProviderId,
    selectedModel: agent.selectedModel,
  };
}

/**
 * Once a thread has stored modelProviderId + selectedModel, those values are
 * immutable. The picker is disabled on existing threads, so this guard
 * rejects out-of-band/manual API callers that try to change or clear them.
 */
async function rejectIfThreadModelLocked(
  threadId: string,
  incoming: { modelProviderId: string; selectedModel: string } | null,
): Promise<boolean> {
  const [existing] = await globalThis.services.db
    .select({
      modelProviderId: chatThreads.modelProviderId,
      selectedModel: chatThreads.selectedModel,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (
    !existing ||
    existing.modelProviderId === null ||
    existing.selectedModel === null
  ) {
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

/**
 * Resolve an existing thread or create a new one.
 * Returns thread metadata needed for run creation and title generation.
 *
 * When `dims` is provided, each sub-stage (create-thread, get-thread,
 * session-id lookup, has-any-run, incomplete-rounds, continue-from resolution)
 * emits a span to the `sandbox-op-log` Axiom dataset with
 * `source: "web-chat"`. Each parallel arm is wrapped in `timed()` so the
 * per-query duration is still captured alongside the parallel execution.
 */
async function resolveThread(
  userId: string,
  agentId: string,
  existingThreadId: string | undefined,
  dims?: ChatSpanDimensions,
): Promise<ResolvedThread> {
  const emit = (op: string, ms: number): void => {
    if (dims) recordChatSpan(op, ms, dims);
  };

  if (!existingThreadId) {
    const createT = await timed(async () => {
      return createChatThread(userId, agentId);
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
      continueFromSchedulePrompt: undefined,
      incompleteContext: "",
      isNewThread: true,
    };
  }

  // Four independent reads keyed off `(existingThreadId, userId)`. Running
  // them in parallel caps wall time at the slowest arm. The prior 4th arm
  // (`getLatestMessagesByThreadId`) was a ~275ms P50 read used only by the
  // fire-and-forget title generator — now lifted off this critical path. It
  // is replaced by the cheap `hasAnyRunsForThread` EXISTS probe so the
  // continue-from-schedule gate keeps its first-run semantics without a
  // 10-row scan on every send.
  const [threadT, sessionIdT, hasAnyRunT, incompleteT] = await Promise.all([
    timed(async () => {
      return getChatThread(existingThreadId, userId);
    }),
    timed(async () => {
      return getLatestSessionIdForThread(existingThreadId);
    }),
    timed(async () => {
      return hasAnyRunsForThread(existingThreadId);
    }),
    timed(async () => {
      return getIncompleteRoundsSinceLastSuccess(existingThreadId);
    }),
  ]);
  emit(CHAT_REQUEST_OPS.resolve_thread_get_thread, threadT.ms);
  emit(CHAT_REQUEST_OPS.resolve_thread_session_id, sessionIdT.ms);
  emit(CHAT_REQUEST_OPS.resolve_thread_has_any_run, hasAnyRunT.ms);
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

  let continueFromSchedulePrompt: string | undefined;
  const sourceScheduleRunId = thread.sourceScheduleRunId;
  if (sourceScheduleRunId && !hasAnyRunT.result) {
    const continueFromT = await timed(async () => {
      return globalThis.services.db
        .select({ name: zeroAgentSchedules.name })
        .from(zeroRuns)
        .innerJoin(
          zeroAgentSchedules,
          eq(zeroRuns.scheduleId, zeroAgentSchedules.id),
        )
        .where(eq(zeroRuns.id, sourceScheduleRunId))
        .limit(1);
    });
    emit(CHAT_REQUEST_OPS.resolve_thread_continue_from, continueFromT.ms);
    const [sourceSchedule] = continueFromT.result;
    continueFromSchedulePrompt = buildContinueFromScheduleSystemPrompt(
      sourceScheduleRunId,
      sourceSchedule?.name ?? null,
    );
  }

  return {
    threadId: thread.id,
    sessionId,
    continueFromSchedulePrompt,
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

const router = tsr.router(chatMessagesContract, {
  send: async ({ body, headers }) => {
    const apiStartTime = Date.now();
    initServices();

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

    if (!agent) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent not found", code: "NOT_FOUND" as const },
        },
      };
    }

    // Validate per-run model selection belongs to the caller's org before
    // we trust it to write onto the thread or override the agent's default.
    // resolveOrg already fetches org_metadata — capture the tier here so the
    // service's Round 2 can skip its duplicate getOrgMetadata call.
    let preloadedOrgTier: { orgId: string; tier: string } | undefined;
    if (body.modelSelection) {
      const modelSelection = body.modelSelection;
      const validateT = await timed(async () => {
        const { org } = await resolveOrg(authCtx);
        preloadedOrgTier = { orgId: org.orgId, tier: org.tier };
        return globalThis.services.db
          .select({ id: modelProviders.id })
          .from(modelProviders)
          .where(
            and(
              eq(modelProviders.id, modelSelection.modelProviderId),
              eq(modelProviders.orgId, org.orgId),
            ),
          )
          .limit(1);
      });
      emit(CHAT_REQUEST_OPS.model_selection_validate, validateT.ms);
      const [provider] = validateT.result;
      if (!provider) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: "Unknown model provider for this workspace",
              code: "BAD_REQUEST" as const,
            },
          },
        };
      }
    }

    if (body.threadId !== undefined && body.modelSelection !== undefined) {
      const threadId = body.threadId;
      const modelSelection = body.modelSelection;
      const lockT = await timed(async () => {
        return rejectIfThreadModelLocked(threadId, modelSelection);
      });
      emit(CHAT_REQUEST_OPS.model_selection_lock_check, lockT.ms);
      if (lockT.result) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: "Cannot change model on an existing thread",
              code: "BAD_REQUEST" as const,
            },
          },
        };
      }
    }

    try {
      const {
        threadId,
        sessionId,
        continueFromSchedulePrompt,
        incompleteContext,
        isNewThread,
      } = await resolveThread(
        authCtx.userId,
        body.agentId,
        body.threadId,
        dims,
      );

      const overrideT = await timed(async () => {
        return resolveRunModelOverride(
          threadId,
          {
            modelProviderId: agent.modelProviderId,
            selectedModel: agent.selectedModel,
          },
          body.modelSelection,
        );
      });
      emit(CHAT_REQUEST_OPS.resolve_model_override, overrideT.ms);
      const override = overrideT.result;

      // Only generate title when prompt has actual user text. The
      // assistant reply is not yet available at send time — the chat
      // callback regenerates the title with the full current exchange
      // once the run completes.
      //
      // Title context fetch lives in this fire-and-forget IIFE so the
      // ~275ms `chat_messages` read is not on the POST response path. For
      // brand-new threads the fetch is skipped (no prior rounds exist), so
      // we only pay the round trip on follow-up sends.
      if (body.hasTextContent !== false) {
        void (async () => {
          let priorRounds:
            | { role: "user" | "assistant"; content: string }[]
            | undefined;
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
            currentUserMessage: body.prompt,
            priorRounds,
          });
          if (title) {
            await updateChatThreadTitle(threadId, authCtx.userId, title);
          }
        })().catch((err: unknown) => {
          log.warn("Chat title generation failed", { threadId, err });
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

      const modelProvider =
        body.modelProvider && body.modelProvider !== "default"
          ? body.modelProvider
          : undefined;

      // Build prompt: user text + file descriptions appended
      const fullPrompt = buildFullPrompt(body.prompt, body.attachFiles);

      // Create the run. Phase 2 dispatch is deferred inside createZeroRun
      // via after() so the response flushes before tokens/secrets/runner work.
      const result = await createZeroRun({
        userId: authCtx.userId,
        prompt: fullPrompt,
        agentId: body.agentId,
        sessionId,
        triggerSource: "web",
        apiStartTime,
        modelProvider,
        modelProviderId: override.providerId ?? undefined,
        selectedModelOverride: override.selectedModel ?? undefined,
        appendSystemPrompt: buildAppendSystemPrompt(
          continueFromSchedulePrompt,
          incompleteContext,
        ),
        callbacks: [chatCallback],
        chatThreadId: threadId,
        preloadedAgent: agent,
        preloadedOrgTier,
        spanDims: dims,
        userProfile: userProfileFromClaims(authCtx),
      });

      // Persist user message to chat_messages.
      // Only file IDs are stored — metadata is resolved at query time from S3.
      // insertChatMessage also publishes chatThreadMessageCreated internally,
      // so the paged-messages view picks up the new row.
      // Stamp with the runId so the callback's prior-context filter can
      // exclude this message structurally (by runId) instead of by content.
      await insertChatMessage({
        chatThreadId: threadId,
        userId: authCtx.userId,
        role: "user",
        content: body.prompt,
        runId: result.runId,
        attachFiles: body.attachFiles?.map((f) => {
          return f.id;
        }),
        id: body.clientMessageId,
        spanDims: dims,
      });

      after(async () => {
        await publishUserSignal(
          [authCtx.userId],
          `chatThreadRunCreated:${threadId}`,
        );
        await publishThreadListChanged(authCtx.userId);
      });

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
          status: status as 400 | 401 | 403 | 404,
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
