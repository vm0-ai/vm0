import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { formatRunErrorForExternalSurface } from "@vm0/api-contracts/contracts/errors";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { buildFeishuAgentResponseMessage } from "../../lib/feishu-message-card";
import { logger } from "../../lib/log";
import {
  removeFeishuMessageReaction,
  replyWithFeishuMessage,
  sendFeishuMessage,
} from "../external/feishu-client";
import { writeDb$, type Db } from "../external/db";
import { tapError } from "../utils";
import {
  feishuOrgCallbackPayloadSchema as callbackPayloadSchema,
  type FeishuOrgCallbackPayload,
} from "./feishu-org-callback-payload";
import {
  loadUserFeatureSwitchContext,
  userFeatureSwitchOverrides,
} from "./feature-switches.service";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
} from "./internal-run-callback";
import { formatRunErrorForRunOwner$ } from "./run-error-format.service";
import { getRunOutputText } from "./run-output.service";
import { saveRunSummary, saveRunSummary$ } from "./run-summary.service";
import { resolveIntegrationAgentResponsePresentation } from "./integration-agent-response-presentation.service";

const L = logger("InternalCallbacksFeishuOrg");

interface RunContext {
  readonly userId: string;
  readonly orgId: string;
  readonly prompt: string;
  readonly agentId: string;
  readonly chatThreadId: string | null;
}

interface HandleFeishuCallbackInput {
  readonly db: Db;
  readonly callback: InternalRunCallbackEnvelope;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly formatRunError: (params: {
    readonly runId: string;
    readonly chatThreadId: string | null | undefined;
    readonly errorMessage: string;
  }) => Promise<string>;
  readonly saveRunSummary: (
    runId: string,
    prompt: string,
    resultText: string,
  ) => Promise<void>;
  readonly signal: AbortSignal;
}

async function loadRun(db: Db, runId: string): Promise<RunContext | undefined> {
  const [run] = await db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      prompt: agentRuns.prompt,
      agentId: agentSessions.agentComposeId,
      chatThreadId: zeroRuns.chatThreadId,
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .leftJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return run;
}

async function clearThinkingReaction(args: {
  readonly db: Db;
  readonly payload: FeishuOrgCallbackPayload;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (!args.payload.reactionId) {
    return;
  }
  await tapError(
    removeFeishuMessageReaction({
      db: args.db,
      installationId: args.payload.installationId,
      messageId: args.payload.messageId,
      reactionId: args.payload.reactionId,
      signal: args.signal,
    }),
    (error) => {
      L.warn("Failed to clear Feishu thinking indicator", {
        error,
        messageId: args.payload.messageId,
      });
    },
  );
}

async function sendFeishuCallbackResponse(args: {
  readonly db: Db;
  readonly payload: FeishuOrgCallbackPayload;
  readonly runId: string;
  readonly message: ReturnType<typeof buildFeishuAgentResponseMessage>;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.payload.replyInThread) {
    await replyWithFeishuMessage({
      db: args.db,
      installationId: args.payload.installationId,
      messageId: args.payload.messageId,
      message: args.message,
      replyInThread: true,
      signal: args.signal,
    });
  } else {
    await sendFeishuMessage({
      db: args.db,
      installationId: args.payload.installationId,
      receiveIdType: "chat_id",
      receiveId: args.payload.chatId,
      message: args.message,
      idempotencyKey: args.runId,
      signal: args.signal,
    });
  }
  args.signal.throwIfAborted();
}

async function loadFeishuCallbackConnection(
  db: Db,
  payload: FeishuOrgCallbackPayload,
) {
  const [connection] = await db
    .select({ id: feishuOrgConnections.id })
    .from(feishuOrgConnections)
    .where(
      and(
        eq(feishuOrgConnections.id, payload.connectionId),
        eq(feishuOrgConnections.installationId, payload.installationId),
      ),
    )
    .limit(1);
  return connection;
}

async function handleFeishuCallback(
  args: HandleFeishuCallbackInput,
): Promise<InternalRunCallbackDispatchResult> {
  if (args.callback.status === "progress") {
    return { success: true, skipped: true };
  }
  const parsed = callbackPayloadSchema.safeParse(args.callback.payload);
  if (!parsed.success) {
    return { success: false, error: "Invalid Feishu callback payload" };
  }
  const payload = parsed.data;
  if (payload.canonicalChatDelivery) {
    return { success: true, skipped: true };
  }
  const run = await loadRun(args.db, args.callback.runId);
  args.signal.throwIfAborted();
  if (!run) {
    await clearThinkingReaction({
      db: args.db,
      payload,
      signal: args.signal,
    });
    return { success: false, error: "Agent run not found" };
  }
  const [installation] = await args.db
    .select({
      orgId: feishuOrgInstallations.orgId,
      defaultAgentId: feishuOrgInstallations.defaultComposeId,
    })
    .from(feishuOrgInstallations)
    .where(
      and(
        eq(feishuOrgInstallations.id, payload.installationId),
        eq(feishuOrgInstallations.orgId, run.orgId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (!installation) {
    return { success: false, error: "Feishu installation not found" };
  }
  const connection = await loadFeishuCallbackConnection(args.db, payload);
  args.signal.throwIfAborted();
  if (!connection) {
    await clearThinkingReaction({
      db: args.db,
      payload,
      signal: args.signal,
    });
    return { success: true, skipped: true };
  }
  const output =
    args.callback.status === "failed"
      ? undefined
      : await getRunOutputText(args.db, args.callback.runId, args.signal);
  args.signal.throwIfAborted();
  const errorText =
    args.callback.status === "failed"
      ? await args.formatRunError({
          runId: args.callback.runId,
          chatThreadId: run.chatThreadId,
          errorMessage: args.callback.error ?? "Agent execution failed.",
        })
      : undefined;
  args.signal.throwIfAborted();
  const presentation = await resolveIntegrationAgentResponsePresentation({
    db: args.db,
    orgId: run.orgId,
    userId: run.userId,
    runId: args.callback.runId,
    agentId: payload.agentId ?? run.agentId,
    defaultAgentId: installation.defaultAgentId,
    getFeatureOverrides: args.getFeatureOverrides,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  const responseText =
    args.callback.status === "failed"
      ? (errorText ?? "Agent execution failed.")
      : (output ?? "Task completed successfully.");
  const responseMessage = buildFeishuAgentResponseMessage({
    text: responseText,
    auditUrl: presentation.logsUrl,
    footerText: presentation.footerText,
  });
  await sendFeishuCallbackResponse({
    db: args.db,
    payload,
    runId: args.callback.runId,
    message: responseMessage,
    signal: args.signal,
  });
  await clearThinkingReaction({
    db: args.db,
    payload,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  await args.saveRunSummary(args.callback.runId, run.prompt, output ?? "");
  args.signal.throwIfAborted();
  return { success: true };
}

export const handleFeishuOrgInternalCallback$ = command(
  async (
    { get, set },
    callback: InternalRunCallbackEnvelope,
    signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    return await handleFeishuCallback({
      db: set(writeDb$),
      callback,
      getFeatureOverrides: (orgId, userId) => {
        return get(userFeatureSwitchOverrides(orgId, userId));
      },
      formatRunError: (params) => {
        return set(formatRunErrorForRunOwner$, params, signal);
      },
      saveRunSummary: (runId, prompt, resultText) => {
        return set(
          saveRunSummary$,
          {
            runId,
            triggerSource: "feishu",
            prompt,
            resultText,
          },
          signal,
        );
      },
      signal,
    });
  },
);

export async function handleFeishuOrgInternalCallbackWithoutCcstate(
  db: Db,
  callback: InternalRunCallbackEnvelope,
  signal = new AbortController().signal,
): Promise<InternalRunCallbackDispatchResult> {
  return await handleFeishuCallback({
    db,
    callback,
    getFeatureOverrides: async (orgId, userId) => {
      return (
        (await loadUserFeatureSwitchContext(db, orgId, userId)).overrides ?? {}
      );
    },
    formatRunError: (params) => {
      return Promise.resolve(
        formatRunErrorForExternalSurface({
          code: "INTERNAL_SERVER_ERROR",
          message: params.errorMessage,
        }),
      );
    },
    saveRunSummary: async (runId, prompt, resultText) => {
      await saveRunSummary(
        db,
        {
          runId,
          triggerSource: "feishu",
          prompt,
          resultText,
        },
        signal,
      );
    },
    signal,
  });
}
