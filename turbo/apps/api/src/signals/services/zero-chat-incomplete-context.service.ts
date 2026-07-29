import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import {
  CHAT_EVENT_TYPES,
  chatEventCompatibilityRole,
  type ChatEventType,
} from "@vm0/api-contracts/contracts/chat-events";
import type { UserMessageDocument } from "@vm0/api-contracts/contracts/chat-threads";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  max,
  not,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { executeRawRows } from "../../lib/db-raw-rows";
import type { Db } from "../external/db";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import { visibleChatEventCondition } from "./zero-chat-message-shared.service";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./zero-chat-user-message.service";

const INCOMPLETE_ROUND_LIMIT = 20;
const INCOMPLETE_MESSAGE_CHAR_CAP = 4000;
const successfulRunBoundaryEvent = alias(
  chatMessages,
  "successful_run_boundary_event",
);
const successfulRunBoundaryRevoker = alias(
  chatMessages,
  "successful_run_boundary_revoker",
);

type IncompleteRunStatus = "cancelled" | "failed" | "timeout";

interface IncompleteRoundSelection {
  readonly runId: string;
  readonly status: IncompleteRunStatus;
}

interface IncompleteRoundMessage {
  readonly eventType: ChatEventType;
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly userMessage: UserMessageDocument | null;
  readonly attachFiles: readonly string[] | null;
}

interface IncompleteRound extends IncompleteRoundSelection {
  readonly messages: IncompleteRoundMessage[];
}

const incompleteRoundFrontierRowSchema = z.object({
  runId: z.string(),
  runStatus: z.string(),
  isSuccess: z.boolean(),
});

function isIncompleteRunStatus(value: string): value is IncompleteRunStatus {
  return value === "cancelled" || value === "failed" || value === "timeout";
}

async function selectIncompleteRoundFrontier(
  db: Db,
  threadId: string,
): Promise<{
  readonly rounds: readonly IncompleteRoundSelection[];
  readonly successfulRunId: string | null;
}> {
  const isSuccessfulRun = sql`COALESCE(
    ${and(
      sql`${agentRuns.result} ? 'agentSessionId'`,
      eq(
        sql`jsonb_typeof(${agentRuns.result}->'agentSessionId')`,
        sql`'string'`,
      ),
    )},
    FALSE
  )`;
  // Terminal chat materialization runs in waitUntil, so lifecycle rows can lag
  // behind agent_runs.status. Walk the existing recent-message index instead.
  // The fixed 21-run frontier is the 20-round output plus one boundary candidate.
  const rows = await executeRawRows(
    db,
    sql`
      WITH RECURSIVE incomplete_frontier AS (
      SELECT
        ARRAY[]::uuid[] AS seen_run_ids,
        NULL::uuid AS run_id,
        NULL::text AS run_status,
        FALSE AS is_success,
        0 AS depth

      UNION ALL

      SELECT
        incomplete_frontier.seen_run_ids || candidate.run_id,
        candidate.run_id,
        candidate.run_status,
        candidate.is_success,
        incomplete_frontier.depth + 1
      FROM incomplete_frontier
      CROSS JOIN LATERAL (
        SELECT
          ${chatMessages.runId} AS run_id,
          ${agentRuns.status} AS run_status,
          (${isSuccessfulRun}) AS is_success
        FROM ${chatMessages}
        INNER JOIN ${agentRuns}
          ON ${eq(agentRuns.id, chatMessages.runId)}
        WHERE ${and(
          eq(chatMessages.chatThreadId, threadId),
          isNotNull(chatMessages.runId),
          not(
            sql`${chatMessages.runId} = ANY(incomplete_frontier.seen_run_ids)`,
          ),
          visibleChatEventCondition(db),
          or(
            isSuccessfulRun,
            and(
              inArray(
                agentRuns.status,
                sql`('cancelled', 'failed', 'timeout')`,
              ),
              chatEventTypeIn(CHAT_EVENT_TYPES),
            ),
          ),
        )}
        ORDER BY
          ${desc(chatMessages.seqId)}
        LIMIT 1
      ) AS candidate
      WHERE incomplete_frontier.depth < ${INCOMPLETE_ROUND_LIMIT + 1}
        AND NOT incomplete_frontier.is_success
    )
    SELECT
      run_id AS "runId",
      run_status AS "runStatus",
      is_success AS "isSuccess"
    FROM incomplete_frontier
    WHERE depth > 0
      ORDER BY depth
    `,
    incompleteRoundFrontierRowSchema,
  );

  const rounds: IncompleteRoundSelection[] = [];
  let successfulRunId: string | null = null;
  for (const row of rows) {
    if (row.isSuccess) {
      successfulRunId = row.runId;
      break;
    }
    if (
      rounds.length < INCOMPLETE_ROUND_LIMIT &&
      isIncompleteRunStatus(row.runStatus)
    ) {
      rounds.push({ runId: row.runId, status: row.runStatus });
    }
  }

  return { rounds: rounds.reverse(), successfulRunId };
}

function afterSuccessfulRunBoundary(
  db: Pick<Db, "select">,
  threadId: string,
  successfulRunId: string,
) {
  const boundary = db
    .select({ seqId: max(successfulRunBoundaryEvent.seqId) })
    .from(successfulRunBoundaryEvent)
    .where(
      and(
        eq(successfulRunBoundaryEvent.chatThreadId, threadId),
        eq(successfulRunBoundaryEvent.runId, successfulRunId),
        notExists(
          db
            .select({ id: successfulRunBoundaryRevoker.id })
            .from(successfulRunBoundaryRevoker)
            .where(
              eq(
                successfulRunBoundaryRevoker.revokesEventId,
                successfulRunBoundaryEvent.id,
              ),
            ),
        ),
      ),
    );
  return gt(chatMessages.seqId, sql`COALESCE(${boundary}, 0::bigint)`);
}

async function loadSelectedIncompleteRounds(
  db: Db,
  threadId: string,
  selection: {
    readonly rounds: readonly IncompleteRoundSelection[];
    readonly successfulRunId: string | null;
  },
): Promise<readonly IncompleteRound[]> {
  if (selection.rounds.length === 0) {
    return [];
  }

  const runIds = selection.rounds.map((round) => {
    return round.runId;
  });
  const rows = await db
    .select({
      runId: chatMessages.runId,
      eventType: chatMessages.eventType,
      content: chatMessages.content,
      userMessage: chatMessages.userMessage,
      attachFiles: chatMessages.attachFiles,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        inArray(chatMessages.runId, runIds),
        chatEventTypeIn(CHAT_EVENT_TYPES),
        visibleChatEventCondition(db),
        ...(selection.successfulRunId === null
          ? []
          : [
              afterSuccessfulRunBoundary(
                db,
                threadId,
                selection.successfulRunId,
              ),
            ]),
      ),
    )
    .orderBy(asc(chatMessages.seqId));

  const statusByRunId = new Map(
    selection.rounds.map((round) => {
      return [round.runId, round.status] as const;
    }),
  );
  const roundsByRunId = new Map<string, IncompleteRound>();
  for (const row of rows) {
    if (row.runId === null) {
      continue;
    }
    const status = statusByRunId.get(row.runId);
    if (status === undefined) {
      continue;
    }
    let round = roundsByRunId.get(row.runId);
    if (round === undefined) {
      round = { runId: row.runId, status, messages: [] };
      roundsByRunId.set(row.runId, round);
    }
    round.messages.push({
      eventType: row.eventType,
      role: chatEventCompatibilityRole(row.eventType),
      content: row.content,
      userMessage: row.userMessage,
      attachFiles: row.attachFiles,
    });
  }

  return [...roundsByRunId.values()];
}

function formatAttachFileIds(
  ids: readonly string[] | null | undefined,
): string {
  if (!ids || ids.length === 0) {
    return "";
  }
  return ids
    .map((id) => {
      return `[Web file]\n   [ID] ${id}`;
    })
    .join("\n");
}

function truncateIncomplete(value: string): string {
  if (value.length <= INCOMPLETE_MESSAGE_CHAR_CAP) {
    return value;
  }
  return `${value.slice(0, INCOMPLETE_MESSAGE_CHAR_CAP)}...[truncated]`;
}

function formatIncompleteMessage(
  message: IncompleteRoundMessage,
  inlineTemplatesEnabled: boolean,
): string {
  const userMessage = requiredUserMessageForEvent(
    message.eventType,
    message.userMessage,
  );
  if (userMessage) {
    const prompt = projectUserMessage(userMessage, {
      inlineTemplates: inlineTemplatesEnabled,
    }).agentPrompt;
    return `User: ${truncateIncomplete(prompt) || "[empty message]"}`;
  }
  const attach = formatAttachFileIds(message.attachFiles);
  if (message.role === "user") {
    const body =
      message.content !== null && message.content !== ""
        ? truncateIncomplete(message.content)
        : "[empty message]";
    return attach ? `User: ${body}\n${attach}` : `User: ${body}`;
  }
  if (message.content !== null && message.content !== "") {
    return `Assistant (partial): ${truncateIncomplete(message.content)}`;
  }
  return "Assistant: [no response before run ended]";
}

function buildWebChatIncompleteContext(
  rounds: readonly IncompleteRound[],
  inlineTemplatesEnabled: boolean,
): string {
  if (rounds.length === 0) {
    return "";
  }
  const total = rounds.length;
  const blocks = rounds.map((round, index) => {
    const relativeIndex = index - total + 1;
    const rendered = round.messages.map((message) => {
      return formatIncompleteMessage(message, inlineTemplatesEnabled);
    });
    const hasAssistant = round.messages.some((message) => {
      return message.role === "assistant";
    });
    if (!hasAssistant) {
      rendered.push("Assistant: [no response before run ended]");
    }
    return [
      "---",
      "",
      `- RELATIVE_INDEX: ${relativeIndex}`,
      `- RUN_STATUS: ${round.status}`,
      "",
      ...rendered,
    ].join("\n");
  });
  return [
    "# Incomplete Rounds Context",
    "",
    "The rounds below were sent in this thread but their runs did not complete",
    "(cancelled, failed, or timed out), so the CLI session history does not",
    "contain them. Treat them as part of the conversation you are having with",
    "the user. RELATIVE_INDEX 0 is the most recent incomplete round.",
    "",
    blocks.join("\n\n"),
    "",
    "---",
  ].join("\n");
}

export async function loadWebChatIncompleteContext(
  db: Db,
  threadId: string,
  inlineTemplatesEnabled = false,
): Promise<string> {
  const selection = await selectIncompleteRoundFrontier(db, threadId);
  const rounds = await loadSelectedIncompleteRounds(db, threadId, selection);
  return buildWebChatIncompleteContext(rounds, inlineTemplatesEnabled);
}
