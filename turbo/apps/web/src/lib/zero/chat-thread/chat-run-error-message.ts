import {
  formatChatgptCodexUsageLimitError,
  RUN_ERROR_GUIDANCE,
} from "@vm0/api-contracts/contracts/errors";
import { asc, eq } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";

const REPORT_ERROR_STREAK_THRESHOLD = 2;

const CHAT_RUN_TRANSIENT_ERROR_MESSAGE =
  "Oops, something went wrong. Please try again later.";
const CHAT_RUN_REPORTABLE_ERROR_MESSAGE = "An unexpected error occurred.";

const ACTIONABLE_ERROR_SNIPPETS = [
  ...Object.values(RUN_ERROR_GUIDANCE).flatMap((guidance) => {
    return [guidance.title, guidance.guidance];
  }),
  "Cannot continue session",
  "Invalid signature in thinking block",
  "Run cancelled",
  "usage limit",
  "usage_limit",
  "usage-limit",
  "UsageLimit",
] as const;

function isActionableRunError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return ACTIONABLE_ERROR_SNIPPETS.some((snippet) => {
    return normalized.includes(snippet.toLowerCase());
  });
}

function buildReportableErrorMessage(runId: string): string {
  return `${CHAT_RUN_REPORTABLE_ERROR_MESSAGE} [Report this issue](/runs/${encodeURIComponent(runId)}/report-error)`;
}

async function getGenericErrorStreakForRun(params: {
  chatThreadId: string;
  runId: string;
  currentErrorMessage: string;
}): Promise<number> {
  const rows = await globalThis.services.db
    .select({
      runId: zeroRuns.id,
      error: agentRuns.error,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(zeroRuns.chatThreadId, params.chatThreadId))
    .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id));

  let streak = 0;
  for (const row of rows) {
    const errorMessage =
      row.runId === params.runId ? params.currentErrorMessage : row.error;
    if (!errorMessage?.trim()) {
      streak = 0;
    } else if (isActionableRunError(errorMessage)) {
      streak = 0;
    } else {
      streak += 1;
    }

    if (row.runId === params.runId) {
      return streak;
    }
  }

  return 1;
}

export async function formatChatRunErrorMessage(params: {
  chatThreadId: string;
  runId: string;
  errorMessage: string;
}): Promise<string> {
  const errorMessage = params.errorMessage.trim() || "Run failed";
  const chatgptCodexUsageLimitMessage =
    formatChatgptCodexUsageLimitError(errorMessage);
  if (chatgptCodexUsageLimitMessage) {
    return chatgptCodexUsageLimitMessage;
  }

  if (isActionableRunError(errorMessage)) {
    return errorMessage;
  }

  const streak = await getGenericErrorStreakForRun({
    chatThreadId: params.chatThreadId,
    runId: params.runId,
    currentErrorMessage: errorMessage,
  });

  return streak >= REPORT_ERROR_STREAK_THRESHOLD
    ? buildReportableErrorMessage(params.runId)
    : CHAT_RUN_TRANSIENT_ERROR_MESSAGE;
}
