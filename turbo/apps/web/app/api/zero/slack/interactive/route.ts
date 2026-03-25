import { NextResponse } from "next/server";
import { eq, and, isNull, gte } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import {
  verifySlackSignature,
  getSlackSignatureHeaders,
} from "../../../../../src/lib/slack/verify";
import { slackOrgInstallations } from "../../../../../src/db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../../../src/db/schema/slack-org-connection";
import { slackOrgPendingQuestions } from "../../../../../src/db/schema/slack-org-pending-question";
import { decryptSecretValue } from "../../../../../src/lib/crypto/secrets-encryption";
import {
  createSlackClient,
  updateMessage,
  setThreadStatus,
} from "../../../../../src/lib/slack/client";
import {
  buildAskUserAnsweredBlocks,
  buildErrorMessage,
} from "../../../../../src/lib/slack/blocks";
import type { AskUserQuestion } from "../../../../../src/lib/slack/blocks";
import { runAgentForSlackOrg } from "../../../../../src/lib/slack-org/handlers/run-agent";
import type { SlackOrgCallbackPayload } from "../../../../../src/lib/callback/callback-payloads";
import { getWorkspaceAgent } from "../../../../../src/lib/slack-org/handlers/shared";
import { refreshOrgAppHome } from "../../../../../src/lib/slack-org/handlers/app-home";
import { disconnect } from "../../../../../src/lib/slack-org/connect-service";
import { logger } from "../../../../../src/lib/logger";

const askUserQuestionSchema = z.array(
  z.object({
    question: z.string(),
    header: z.string().optional(),
    options: z
      .array(
        z.object({
          label: z.string(),
          description: z.string().optional(),
        }),
      )
      .optional(),
    multiSelect: z.boolean().optional(),
  }),
);

const log = logger("slack-org:interactive");

interface SlackInteractivePayload {
  type: "view_submission" | "block_actions" | "shortcut";
  user: {
    id: string;
    username: string;
    team_id: string;
  };
  team: {
    id: string;
    domain: string;
  };
  channel?: {
    id: string;
  };
  message?: {
    ts: string;
  };
  trigger_id?: string;
  actions?: Array<{
    action_id: string;
    block_id: string;
    value?: string;
    selected_option?: { value: string };
    selected_options?: Array<{ value: string }>;
  }>;
  state?: {
    values: Record<
      string,
      Record<
        string,
        {
          type: string;
          selected_options?: Array<{ value: string }>;
        }
      >
    >;
  };
}

/**
 * POST /api/zero/slack/interactive
 *
 * Org-aware interactive component handler.
 */
export async function POST(request: Request) {
  const { SLACK_SIGNING_SECRET } = env();

  if (!SLACK_SIGNING_SECRET) {
    return NextResponse.json(
      { error: "Slack integration is not configured" },
      { status: 503 },
    );
  }

  const body = await request.text();
  const headers = getSlackSignatureHeaders(request.headers);
  if (!headers) {
    return NextResponse.json(
      { error: "Missing Slack signature headers" },
      { status: 401 },
    );
  }

  const isValid = verifySlackSignature(
    SLACK_SIGNING_SECRET,
    headers.signature,
    headers.timestamp,
    body,
  );

  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const params = new URLSearchParams(body);
  const payloadStr = params.get("payload");

  if (!payloadStr) {
    return NextResponse.json({ error: "Missing payload" }, { status: 400 });
  }

  let payload: SlackInteractivePayload;
  try {
    payload = JSON.parse(payloadStr) as SlackInteractivePayload;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  initServices();

  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];
    if (!action) {
      return new Response("", { status: 200 });
    }

    if (action.action_id === "home_disconnect") {
      await handleHomeDisconnect(payload);
    } else if (action.action_id === "ask_user_submit") {
      handleAskUserSubmit(payload).catch((err: unknown) => {
        log.error("Failed to handle askUserQuestion submit:", err);
      });
    } else if (/^ask_user_pick_q\d+_o\d+$/.test(action.action_id)) {
      handleDirectPick(payload, action).catch((err: unknown) => {
        log.error("Failed to handle direct pick:", err);
      });
    }
  }

  return new Response("", { status: 200 });
}

/**
 * Handle disconnect button click from App Home.
 */
async function handleHomeDisconnect(
  payload: SlackInteractivePayload,
): Promise<void> {
  const [connection] = await globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, payload.user.id),
        eq(slackOrgConnections.slackWorkspaceId, payload.team.id),
      ),
    )
    .limit(1);

  if (!connection) {
    return;
  }

  await disconnect({
    connectionId: connection.id,
    userId: connection.vm0UserId,
  });

  // Refresh App Home to show disconnected state
  const { SECRETS_ENCRYPTION_KEY } = env();
  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, payload.team.id))
    .limit(1);

  if (!installation) {
    return;
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);
  await refreshOrgAppHome(client, installation, payload.user.id);
}

// ---------------------------------------------------------------------------
// askUserQuestion interactive card handling
// ---------------------------------------------------------------------------

type SlackAction = NonNullable<SlackInteractivePayload["actions"]>[number];

/**
 * Verify the submitting user is the initiator of the pending question.
 */
async function validateSubmitter(
  claimed: typeof slackOrgPendingQuestions.$inferSelect,
  slackUserId: string,
): Promise<boolean> {
  const [connection] = await globalThis.services.db
    .select({ slackUserId: slackOrgConnections.slackUserId })
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.id, claimed.connectionId))
    .limit(1);

  if (connection && connection.slackUserId === slackUserId) {
    return true;
  }

  // Roll back answeredAt so the real user can still answer
  await globalThis.services.db
    .update(slackOrgPendingQuestions)
    .set({ answeredAt: null })
    .where(eq(slackOrgPendingQuestions.id, claimed.id));

  // Post ephemeral rejection
  const { SECRETS_ENCRYPTION_KEY } = env();
  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, claimed.slackWorkspaceId))
    .limit(1);

  if (installation) {
    const botToken = decryptSecretValue(
      installation.encryptedBotToken,
      SECRETS_ENCRYPTION_KEY,
    );
    const client = createSlackClient(botToken);
    await client.chat.postEphemeral({
      channel: claimed.slackChannelId,
      user: slackUserId,
      text: "Only the person who started this conversation can answer this question.",
    });
  }

  log.warn("Unauthorized ask-user submit attempt", {
    pendingId: claimed.id,
    expectedConnectionId: claimed.connectionId,
    actualSlackUserId: slackUserId,
  });

  return false;
}

/**
 * Handle direct-submit button click (single question, single-select).
 */
async function handleDirectPick(
  payload: SlackInteractivePayload,
  action: SlackAction,
): Promise<void> {
  const pendingId = action.value;
  if (!pendingId) return;

  const match = action.action_id.match(/^ask_user_pick_q(\d+)_o(\d+)$/);
  if (!match) return;

  const qIdx = parseInt(match[1]!, 10);
  const oIdx = parseInt(match[2]!, 10);

  const now = new Date();
  const [claimed] = await globalThis.services.db
    .update(slackOrgPendingQuestions)
    .set({ answeredAt: now })
    .where(
      and(
        eq(slackOrgPendingQuestions.id, pendingId),
        isNull(slackOrgPendingQuestions.answeredAt),
        gte(slackOrgPendingQuestions.expiresAt, now),
      ),
    )
    .returning();

  if (!claimed) return;

  const authorized = await validateSubmitter(claimed, payload.user.id);
  if (!authorized) return;

  const parsed = askUserQuestionSchema.safeParse(claimed.questions);
  if (!parsed.success) return;

  const questions: AskUserQuestion[] = parsed.data;
  const opt = questions[qIdx]?.options?.[oIdx];
  if (!opt) return;

  const answers = new Map<number, string[]>();
  answers.set(qIdx, [opt.label]);
  const answerPrompt = buildAnswerPrompt(questions, answers);

  await finishSubmit(payload, claimed, questions, answers, answerPrompt);
}

function collectAnswersFromState(
  stateValues: NonNullable<SlackInteractivePayload["state"]>["values"],
  questions: AskUserQuestion[],
): Map<number, string[]> {
  const answers = new Map<number, string[]>();

  for (const [blockId, actions] of Object.entries(stateValues)) {
    const blockMatch = blockId.match(/^ask_user_block_q(\d+)$/);
    if (!blockMatch) continue;

    const qIdx = parseInt(blockMatch[1]!, 10);
    const q = questions[qIdx];
    if (!q) continue;

    for (const element of Object.values(actions)) {
      if (element.selected_options && element.selected_options.length > 0) {
        const labels: string[] = [];
        for (const selOpt of element.selected_options) {
          const optMatch = selOpt.value.match(/^q\d+_o(\d+)$/);
          if (optMatch) {
            const opt = q.options?.[parseInt(optMatch[1]!, 10)];
            if (opt) {
              labels.push(opt.label);
            }
          }
        }
        if (labels.length > 0) {
          answers.set(qIdx, labels);
        }
      }
    }
  }

  return answers;
}

function buildAnswerPrompt(
  questions: AskUserQuestion[],
  answers: Map<number, string[]>,
): string {
  const items: string[] = [];
  for (let qIdx = 0; qIdx < questions.length; qIdx++) {
    const selected = answers.get(qIdx);
    if (selected) {
      for (const label of selected) {
        items.push(`- ${label}`);
      }
    }
  }
  return items.length > 0
    ? `User selected:\n${items.join("\n")}`
    : "The user submitted the form without making a selection.";
}

async function updateCardWithError(
  channelId: string,
  messageTs: string | null,
  workspaceId: string,
  errorText: string,
): Promise<void> {
  if (!messageTs) {
    return;
  }
  const { SECRETS_ENCRYPTION_KEY } = env();
  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);
  if (!installation) {
    return;
  }
  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);
  await updateMessage(
    client,
    channelId,
    messageTs,
    errorText,
    buildErrorMessage(errorText),
  );
}

async function handleAskUserSubmit(
  payload: SlackInteractivePayload,
): Promise<void> {
  const action = payload.actions?.find(
    (a) => a.action_id === "ask_user_submit",
  );
  const pendingId = action?.value;

  if (!pendingId) {
    log.warn("ask_user_submit missing pendingId");
    return;
  }

  const now = new Date();
  const [claimed] = await globalThis.services.db
    .update(slackOrgPendingQuestions)
    .set({ answeredAt: now })
    .where(
      and(
        eq(slackOrgPendingQuestions.id, pendingId),
        isNull(slackOrgPendingQuestions.answeredAt),
        gte(slackOrgPendingQuestions.expiresAt, now),
      ),
    )
    .returning();

  if (!claimed) {
    log.warn("Pending question not found, already answered, or expired", {
      pendingId,
    });
    return;
  }

  const authorized = await validateSubmitter(claimed, payload.user.id);
  if (!authorized) return;

  const parsed = askUserQuestionSchema.safeParse(claimed.questions);
  if (!parsed.success) {
    log.error("Invalid questions data in pending question", {
      pendingId,
      error: parsed.error,
    });
    await updateCardWithError(
      claimed.slackChannelId,
      claimed.slackMessageTs,
      claimed.slackWorkspaceId,
      "Something went wrong processing your answer. Please try again.",
    );
    return;
  }

  const questions: AskUserQuestion[] = parsed.data;

  const answers = collectAnswersFromState(
    payload.state?.values ?? {},
    questions,
  );
  const answerPrompt = buildAnswerPrompt(questions, answers);

  await finishSubmit(payload, claimed, questions, answers, answerPrompt);
}

/**
 * Shared post-submit logic: update the card, set thinking status, dispatch run.
 */
async function finishSubmit(
  payload: SlackInteractivePayload,
  claimed: typeof slackOrgPendingQuestions.$inferSelect,
  questions: AskUserQuestion[],
  answers: Map<number, string[]>,
  answerPrompt: string,
): Promise<void> {
  const pendingId = claimed.id;

  const { SECRETS_ENCRYPTION_KEY } = env();
  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, claimed.slackWorkspaceId))
    .limit(1);

  if (!installation) {
    log.error("Installation not found for pending question", { pendingId });
    await updateCardWithError(
      claimed.slackChannelId,
      claimed.slackMessageTs,
      claimed.slackWorkspaceId,
      "Slack installation not found. Please reconnect the Zero app.",
    );
    return;
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  // Resolve display name for user-visible blocks
  const agentInfo = await getWorkspaceAgent(claimed.composeId);
  const agentLabel = agentInfo?.displayName ?? claimed.agentName;

  // Replace interactive card with answered summary
  if (claimed.slackMessageTs) {
    const answeredBlocks = buildAskUserAnsweredBlocks(
      questions,
      answers,
      agentLabel,
    );
    await updateMessage(
      client,
      claimed.slackChannelId,
      claimed.slackMessageTs,
      answerPrompt,
      answeredBlocks,
    );
  }

  // Set thinking status
  try {
    await setThreadStatus(
      client,
      claimed.slackChannelId,
      claimed.slackThreadTs,
      "is thinking...",
    );
  } catch (err) {
    log.debug("Failed to set thread status", { error: err });
  }

  // Look up connection to get userId for the run
  const [connection] = await globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.id, claimed.connectionId))
    .limit(1);

  if (!connection) {
    log.error("Connection not found for pending question", { pendingId });
    await updateCardWithError(
      claimed.slackChannelId,
      claimed.slackMessageTs,
      claimed.slackWorkspaceId,
      "Your Zero account connection was not found. Please reconnect your account.",
    );
    return;
  }

  // Dispatch new agent run with the user's answer
  const callbackContext: SlackOrgCallbackPayload = {
    workspaceId: claimed.slackWorkspaceId,
    channelId: claimed.slackChannelId,
    threadTs: claimed.slackThreadTs,
    messageTs: claimed.slackThreadTs,
    connectionId: claimed.connectionId,
    agentId: claimed.composeId,
    existingSessionId: claimed.sessionId ?? undefined,
  };

  if (!agentInfo) {
    log.error("Zero agent not found for compose", {
      composeId: claimed.composeId,
    });
    await updateCardWithError(
      claimed.slackChannelId,
      claimed.slackMessageTs,
      claimed.slackWorkspaceId,
      "The agent could not be found. Please contact your org admin.",
    );
    return;
  }

  await runAgentForSlackOrg({
    composeId: claimed.composeId,
    agentId: agentInfo.agentId,
    agentName: claimed.agentName,
    sessionId: claimed.sessionId ?? undefined,
    prompt: answerPrompt,
    threadContext: "",
    userContext: "",
    userId: connection.vm0UserId,
    botUserId: installation.botUserId,
    callbackContext,
  });

  log.debug("askUserQuestion answer dispatched", {
    pendingId,
    answerPrompt,
  });
}
