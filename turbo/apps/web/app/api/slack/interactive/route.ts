import { NextResponse } from "next/server";
import { eq, and, isNull } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import {
  verifySlackSignature,
  getSlackSignatureHeaders,
} from "../../../../src/lib/slack/verify";
import { slackInstallations } from "../../../../src/db/schema/slack-installation";
import { slackUserLinks } from "../../../../src/db/schema/slack-user-link";
import { slackPendingQuestions } from "../../../../src/db/schema/slack-pending-question";
import { decryptCredentialValue } from "../../../../src/lib/crypto/secrets-encryption";
import {
  createSlackClient,
  updateMessage,
  setThreadStatus,
  refreshAppHome,
  buildAskUserAnsweredBlocks,
} from "../../../../src/lib/slack";
import type { AskUserQuestion } from "../../../../src/lib/slack";
import { runAgentForSlack } from "../../../../src/lib/slack/handlers/run-agent";
import type { SlackCallbackContext } from "../../../../src/lib/slack/handlers/run-agent";
import { logger } from "../../../../src/lib/logger";

const log = logger("slack:interactive");

/**
 * Slack Interactive Components Endpoint
 *
 * POST /api/slack/interactive
 *
 * Handles interactive component callbacks:
 * - block_actions - Button clicks from App Home and askUserQuestion cards
 */

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
}

export async function POST(request: Request) {
  const { SLACK_SIGNING_SECRET } = env();

  if (!SLACK_SIGNING_SECRET) {
    return NextResponse.json(
      { error: "Slack integration is not configured" },
      { status: 503 },
    );
  }

  // Get raw body for signature verification
  const body = await request.text();

  // Verify Slack signature
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

  // Parse URL-encoded form data (payload is in 'payload' field)
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

  // Handle block actions (button clicks)
  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];
    if (!action) {
      return new Response("", { status: 200 });
    }

    if (action.action_id === "home_disconnect") {
      await handleHomeDisconnect(payload);
    } else if (action.action_id === "ask_user_submit") {
      // Submit all answers — process in background so we respond within 3 seconds
      handleAskUserSubmit(payload).catch((err: unknown) => {
        log.error("Failed to handle askUserQuestion submit:", err);
      });
    }
    // Single-select button clicks (ask_user_q*_o*) and checkbox changes
    // (ask_user_multi_q*) are acknowledged but not acted on until Submit.
    // Slack stores the UI state client-side.
  }

  return new Response("", { status: 200 });
}

/**
 * Handle disconnect button click from App Home
 */
async function handleHomeDisconnect(
  payload: SlackInteractivePayload,
): Promise<void> {
  const [userLink] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, payload.user.id),
        eq(slackUserLinks.slackWorkspaceId, payload.team.id),
      ),
    )
    .limit(1);

  if (!userLink) {
    return;
  }

  // Delete user link
  await globalThis.services.db
    .delete(slackUserLinks)
    .where(eq(slackUserLinks.id, userLink.id));

  // Refresh App Home to show disconnected state
  const { SECRETS_ENCRYPTION_KEY } = env();
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, payload.team.id))
    .limit(1);

  if (!installation) {
    return;
  }

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);
  await refreshAppHome(client, installation, payload.user.id);
}

// ---------------------------------------------------------------------------
// askUserQuestion interactive card handling
// ---------------------------------------------------------------------------

type SlackAction = NonNullable<SlackInteractivePayload["actions"]>[number];

/**
 * Extract user selections from Slack interactive payload actions.
 *
 * Parses single-select button clicks (ask_user_q{N}_o{M}) and
 * multi-select checkbox selections (ask_user_multi_q{N}).
 */
function collectAnswersFromActions(
  actions: SlackAction[],
  questions: AskUserQuestion[],
): Map<number, string[]> {
  const answers = new Map<number, string[]>();

  for (const act of actions) {
    // Single-select button: ask_user_q{N}_o{M}
    const btnMatch = act.action_id.match(/^ask_user_q(\d+)_o(\d+)$/);
    if (btnMatch) {
      const qIdx = parseInt(btnMatch[1]!, 10);
      const oIdx = parseInt(btnMatch[2]!, 10);
      const opt = questions[qIdx]?.options?.[oIdx];
      if (opt) {
        answers.set(qIdx, [opt.label]);
      }
    }

    // Multi-select checkbox: ask_user_multi_q{N}
    const multiMatch = act.action_id.match(/^ask_user_multi_q(\d+)$/);
    if (multiMatch && act.selected_options) {
      const qIdx = parseInt(multiMatch[1]!, 10);
      const q = questions[qIdx];
      const labels: string[] = [];
      for (const selOpt of act.selected_options) {
        const optMatch = selOpt.value.match(/^q\d+_o(\d+)$/);
        if (optMatch) {
          const opt = q?.options?.[parseInt(optMatch[1]!, 10)];
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

  return answers;
}

/**
 * Build a human-readable answer prompt from questions and selected answers.
 */
function buildAnswerPrompt(
  questions: AskUserQuestion[],
  answers: Map<number, string[]>,
): string {
  const parts: string[] = [];
  for (let qIdx = 0; qIdx < questions.length; qIdx++) {
    const selected = answers.get(qIdx);
    if (selected && selected.length > 0) {
      parts.push(
        `The user was asked: "${questions[qIdx]!.question}" and selected: "${selected.join(", ")}"`,
      );
    }
  }
  return parts.length > 0
    ? parts.join("\n")
    : "The user submitted the form without making a selection.";
}

/**
 * Handle the Submit button click on an askUserQuestion interactive card.
 *
 * Collects all selections from the card's actions state, updates the card
 * to show "Answered", and dispatches a new agent run with the user's answers.
 */
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

  // Look up pending question
  const [pending] = await globalThis.services.db
    .select()
    .from(slackPendingQuestions)
    .where(
      and(
        eq(slackPendingQuestions.id, pendingId),
        isNull(slackPendingQuestions.answeredAt),
      ),
    )
    .limit(1);

  if (!pending) {
    log.warn("Pending question not found or already answered", { pendingId });
    return;
  }

  if (new Date() > pending.expiresAt) {
    log.warn("Pending question expired", { pendingId });
    return;
  }

  // Mark as answered
  await globalThis.services.db
    .update(slackPendingQuestions)
    .set({ answeredAt: new Date() })
    .where(eq(slackPendingQuestions.id, pendingId));

  const questions = pending.questions as AskUserQuestion[];
  const answers = collectAnswersFromActions(payload.actions ?? [], questions);
  const answerPrompt = buildAnswerPrompt(questions, answers);

  // Update the Slack message to show answered state
  const { SECRETS_ENCRYPTION_KEY } = env();
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, pending.slackWorkspaceId))
    .limit(1);

  if (!installation) {
    log.error("Installation not found for pending question", { pendingId });
    return;
  }

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  // Replace interactive card with answered summary
  if (pending.slackMessageTs) {
    const answeredBlocks = buildAskUserAnsweredBlocks(
      questions,
      answers,
      pending.agentName,
    );
    await updateMessage(
      client,
      pending.slackChannelId,
      pending.slackMessageTs,
      answerPrompt,
      answeredBlocks,
    );
  }

  // Set thinking status
  try {
    await setThreadStatus(
      client,
      pending.slackChannelId,
      pending.slackThreadTs,
      "is thinking...",
    );
  } catch (err) {
    log.debug("Failed to set thread status", { error: err });
  }

  // Look up user link to get userId for the run
  const [userLink] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(eq(slackUserLinks.id, pending.userLinkId))
    .limit(1);

  if (!userLink) {
    log.error("User link not found for pending question", { pendingId });
    return;
  }

  // Dispatch new agent run with the user's answer
  const callbackContext: SlackCallbackContext = {
    workspaceId: pending.slackWorkspaceId,
    channelId: pending.slackChannelId,
    threadTs: pending.slackThreadTs,
    messageTs: pending.slackThreadTs,
    userLinkId: pending.userLinkId,
    agentName: pending.agentName,
    composeId: pending.composeId,
    existingSessionId: pending.sessionId ?? undefined,
  };

  await runAgentForSlack({
    composeId: pending.composeId,
    agentName: pending.agentName,
    sessionId: pending.sessionId ?? undefined,
    prompt: answerPrompt,
    threadContext: "",
    userId: userLink.vm0UserId,
    callbackContext,
  });

  log.debug("askUserQuestion answer dispatched", {
    pendingId,
    answerPrompt,
  });
}
