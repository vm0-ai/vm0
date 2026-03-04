import { NextResponse } from "next/server";
import { eq, and, isNull, gte } from "drizzle-orm";
import { z } from "zod";
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
  buildErrorMessage,
} from "../../../../src/lib/slack";
import type { AskUserQuestion } from "../../../../src/lib/slack";
import { runAgentForSlack } from "../../../../src/lib/slack/handlers/run-agent";
import type { SlackCallbackContext } from "../../../../src/lib/slack/handlers/run-agent";
import { logger } from "../../../../src/lib/logger";

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
  /** Contains current values of all interactive elements in the message */
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
    } else if (/^ask_user_pick_q\d+_o\d+$/.test(action.action_id)) {
      // Direct-submit button click (single question, single-select)
      handleDirectPick(payload, action).catch((err: unknown) => {
        log.error("Failed to handle direct pick:", err);
      });
    }
    // Checkbox selections are maintained client-side by Slack.
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
 * Handle direct-submit button click (single question, single-select).
 * The button click IS the answer — no separate Submit step.
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

  // Atomically claim — also reject expired records in the WHERE clause
  // so that claiming an expired record is impossible.
  const now = new Date();
  const [claimed] = await globalThis.services.db
    .update(slackPendingQuestions)
    .set({ answeredAt: now })
    .where(
      and(
        eq(slackPendingQuestions.id, pendingId),
        isNull(slackPendingQuestions.answeredAt),
        gte(slackPendingQuestions.expiresAt, now),
      ),
    )
    .returning();

  if (!claimed) return;

  const parsed = askUserQuestionSchema.safeParse(claimed.questions);
  if (!parsed.success) return;

  const questions: AskUserQuestion[] = parsed.data;
  const opt = questions[qIdx]?.options?.[oIdx];
  if (!opt) return;

  const answers = new Map<number, string[]>();
  answers.set(qIdx, [opt.label]);
  const answerPrompt = buildAnswerPrompt(questions, answers);

  // Update card to answered state + dispatch run (reuse shared logic)
  await finishSubmit(payload, claimed, questions, answers, answerPrompt);
}

/**
 * Extract user selections from Slack `state.values`.
 *
 * When a block_actions payload is received, `state.values` contains the
 * current values of ALL interactive elements in the message, keyed by
 * block_id → action_id.
 */
function collectAnswersFromState(
  stateValues: NonNullable<SlackInteractivePayload["state"]>["values"],
  questions: AskUserQuestion[],
): Map<number, string[]> {
  const answers = new Map<number, string[]>();

  for (const [blockId, actions] of Object.entries(stateValues)) {
    // Match block_id pattern: ask_user_block_q{N}
    const blockMatch = blockId.match(/^ask_user_block_q(\d+)$/);
    if (!blockMatch) continue;

    const qIdx = parseInt(blockMatch[1]!, 10);
    const q = questions[qIdx];
    if (!q) continue;

    for (const element of Object.values(actions)) {
      // Checkboxes — used for both single-select and multi-select
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

/**
 * Build a human-readable answer prompt from selected answers.
 * The agent already has session context, so we only include what the user chose.
 */
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

/**
 * Update the Slack card with an error message. Best-effort — if the
 * Slack API call itself fails we just log it.
 */
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
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, workspaceId))
    .limit(1);
  if (!installation) {
    return;
  }
  const botToken = decryptCredentialValue(
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

  // Atomically mark as answered — only the first submit wins.
  // The WHERE clause includes `answeredAt IS NULL` and expiry check
  // so a concurrent second click or expired question matches zero rows.
  const now = new Date();
  const [claimed] = await globalThis.services.db
    .update(slackPendingQuestions)
    .set({ answeredAt: now })
    .where(
      and(
        eq(slackPendingQuestions.id, pendingId),
        isNull(slackPendingQuestions.answeredAt),
        gte(slackPendingQuestions.expiresAt, now),
      ),
    )
    .returning();

  if (!claimed) {
    log.warn("Pending question not found, already answered, or expired", {
      pendingId,
    });
    return;
  }

  // Validate JSONB questions data at runtime
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
 * Used by both handleAskUserSubmit and handleDirectPick.
 */
async function finishSubmit(
  payload: SlackInteractivePayload,
  claimed: typeof slackPendingQuestions.$inferSelect,
  questions: AskUserQuestion[],
  answers: Map<number, string[]>,
  answerPrompt: string,
): Promise<void> {
  const pendingId = claimed.id;

  const { SECRETS_ENCRYPTION_KEY } = env();
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, claimed.slackWorkspaceId))
    .limit(1);

  if (!installation) {
    log.error("Installation not found for pending question", { pendingId });
    await updateCardWithError(
      claimed.slackChannelId,
      claimed.slackMessageTs,
      claimed.slackWorkspaceId,
      "Slack installation not found. Please reconnect the VM0 app.",
    );
    return;
  }

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  // Replace interactive card with answered summary
  if (claimed.slackMessageTs) {
    const answeredBlocks = buildAskUserAnsweredBlocks(
      questions,
      answers,
      claimed.agentName,
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

  // Look up user link to get userId for the run
  const [userLink] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(eq(slackUserLinks.id, claimed.userLinkId))
    .limit(1);

  if (!userLink) {
    log.error("User link not found for pending question", { pendingId });
    await updateCardWithError(
      claimed.slackChannelId,
      claimed.slackMessageTs,
      claimed.slackWorkspaceId,
      "Your VM0 account link was not found. Please reconnect your account.",
    );
    return;
  }

  // Dispatch new agent run with the user's answer
  const callbackContext: SlackCallbackContext = {
    workspaceId: claimed.slackWorkspaceId,
    channelId: claimed.slackChannelId,
    threadTs: claimed.slackThreadTs,
    messageTs: claimed.slackThreadTs,
    userLinkId: claimed.userLinkId,
    agentName: claimed.agentName,
    composeId: claimed.composeId,
    existingSessionId: claimed.sessionId ?? undefined,
  };

  await runAgentForSlack({
    composeId: claimed.composeId,
    agentName: claimed.agentName,
    sessionId: claimed.sessionId ?? undefined,
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
