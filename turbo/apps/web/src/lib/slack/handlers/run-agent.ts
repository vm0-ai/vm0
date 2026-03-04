import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { createRun } from "../../run";
import { isConcurrentRunLimit } from "../../errors";
import { queryAxiom, getDatasetName, DATASETS } from "../../axiom";
import { logger } from "../../logger";
import { generateCallbackSecret, getApiUrl } from "../../callback";
import type { AskUserQuestion } from "../blocks";

const log = logger("slack:run-agent");

// ---------------------------------------------------------------------------
// Prompt instructions for ask-user questions
// ---------------------------------------------------------------------------

export const ASK_USER_PROMPT_INSTRUCTIONS = `# Ask User Questions

When you need user input with a choice of options, output a fenced code block with the \`ask_user\` language tag at the END of your response. Do NOT use the AskUserQuestion CLI tool.

Format:
\`\`\`ask_user
{"questions":[{"question":"Your question?","header":"Short Label","options":[{"label":"Option 1","description":"Details"},{"label":"Option 2"}],"multiSelect":false}]}
\`\`\`

Rules:
- "question" is required. "header", "options", "multiSelect" are optional.
- Each option must have "label"; "description" is optional.
- Set "multiSelect" to true only when the user can pick more than one option.
- Place the block at the very end of your message, after any explanatory text.`;

// ---------------------------------------------------------------------------
// Zod schema for ask-user questions (shared with interactive/route.ts)
// ---------------------------------------------------------------------------

export const askUserQuestionSchema = z.array(
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

/**
 * Slack-specific context to include in the callback payload
 */
export interface SlackCallbackContext {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userLinkId: string;
  agentName: string;
  composeId: string;
  existingSessionId?: string;
}

interface RunAgentParams {
  composeId: string;
  agentName: string;
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userId: string;
  callbackContext: SlackCallbackContext;
}

interface RunAgentResult {
  status: "dispatched" | "failed";
  response?: string;
  runId: string | undefined;
}

/**
 * Execute an agent run for Slack
 *
 * This creates a run, registers a callback, and returns immediately.
 * The callback will be invoked when the run completes.
 */
export async function runAgentForSlack(
  params: RunAgentParams,
): Promise<RunAgentResult> {
  const {
    composeId,
    agentName,
    sessionId,
    prompt,
    threadContext,
    userId,
    callbackContext,
  } = params;

  try {
    // Get compose and latest version
    const [compose] = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(eq(agentComposes.id, composeId))
      .limit(1);

    if (!compose) {
      return {
        status: "failed",
        response: "Error: Agent configuration not found.",
        runId: undefined,
      };
    }

    // Get latest version (using headVersionId if available, otherwise query)
    let versionId = compose.headVersionId;
    if (!versionId) {
      const [latestVersion] = await globalThis.services.db
        .select({ id: agentComposeVersions.id })
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.composeId, compose.id))
        .orderBy(desc(agentComposeVersions.createdAt))
        .limit(1);

      if (!latestVersion) {
        return {
          status: "failed",
          response: "Error: Agent has no versions configured.",
          runId: undefined,
        };
      }
      versionId = latestVersion.id;
    }

    // Build the full prompt with ask-user instructions and thread context
    const fullPrompt = [
      ASK_USER_PROMPT_INSTRUCTIONS,
      threadContext ? `# Thread Context\n\n${threadContext}` : "",
      `# User Prompt\n\n${prompt}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    // Build callback for run completion notification
    const callbackUrl = `${getApiUrl()}/api/internal/callbacks/slack`;
    const callbackSecret = generateCallbackSecret();

    // Delegate all orchestration to createRun()
    const result = await createRun({
      userId,
      agentComposeVersionId: versionId,
      prompt: fullPrompt,
      composeId: compose.id,
      sessionId,
      agentName,
      artifactName: "artifact",
      callbacks: [
        {
          url: callbackUrl,
          secret: callbackSecret,
          payload: callbackContext,
        },
      ],
    });

    log.debug(`Run ${result.runId} dispatched for Slack agent ${agentName}`);

    return {
      status: "dispatched",
      runId: result.runId,
    };
  } catch (error) {
    if (isConcurrentRunLimit(error)) {
      return {
        status: "failed",
        response:
          "You have too many concurrent runs. Please wait for existing runs to complete.",
        runId: undefined,
      };
    }
    log.error("Error running agent for Slack:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      status: "failed",
      response: `Error executing agent: ${message}`,
      runId: undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Ask-user response parser
// ---------------------------------------------------------------------------

const ASK_USER_BLOCK_RE = /```ask_user\n([\s\S]*?)\n```/;

interface ParsedAskUser {
  questions: AskUserQuestion[];
  cleanText: string;
}

/**
 * Parse an `ask_user` fenced code block from agent text output.
 * Returns the validated questions and the text with the block stripped,
 * or `null` if no valid block is found.
 */
export function parseAskUserFromResponse(text: string): ParsedAskUser | null {
  const match = ASK_USER_BLOCK_RE.exec(text);
  if (!match?.[1]) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }

  const questionsSchema = z.object({ questions: askUserQuestionSchema });
  const result = questionsSchema.safeParse(parsed);
  if (!result.success) return null;

  const cleanText = text.slice(0, match.index).trimEnd();
  return { questions: result.data.questions, cleanText };
}

// ---------------------------------------------------------------------------
// Axiom result querying
// ---------------------------------------------------------------------------

export interface RunResultData {
  result?: string;
  cleanResult?: string;
  askUserQuestions: AskUserQuestion[];
}

/**
 * Query Axiom for the result event data (text output + ask-user questions).
 * Parses ask_user blocks from the agent's text output.
 */
export async function getRunResultData(
  runId: string,
): Promise<RunResultData | undefined> {
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  const apl = `['${dataset}']
| where runId == "${runId}"
| where eventType == "result"
| order by sequenceNumber desc
| limit 1`;

  interface ResultEvent {
    eventData: {
      result?: string;
    };
  }

  const events = await queryAxiom<ResultEvent>(apl);
  if (!events || events.length === 0) {
    return undefined;
  }

  const event = events[0];
  const resultText = event?.eventData?.result;

  if (!resultText) {
    return { result: undefined, cleanResult: undefined, askUserQuestions: [] };
  }

  const parsed = parseAskUserFromResponse(resultText);
  if (parsed) {
    return {
      result: resultText,
      cleanResult: parsed.cleanText,
      askUserQuestions: parsed.questions,
    };
  }

  return { result: resultText, cleanResult: resultText, askUserQuestions: [] };
}

/**
 * Query Axiom for the result event to get the agent's output text.
 * Formats ask-user questions as plain text (fallback for non-interactive contexts).
 */
export async function getRunOutput(runId: string): Promise<string | undefined> {
  const data = await getRunResultData(runId);
  if (!data) {
    return undefined;
  }

  if (data.askUserQuestions.length > 0) {
    const formatted = formatAskUserQuestions(data.askUserQuestions);
    return data.cleanResult ? `${data.cleanResult}\n\n${formatted}` : formatted;
  }

  return data.result;
}

/**
 * Format ask-user questions as plain text for non-interactive contexts.
 */
export function formatAskUserQuestions(questions: AskUserQuestion[]): string {
  const parts: string[] = [];

  for (const q of questions) {
    parts.push(q.question);
    if (q.options) {
      for (const opt of q.options) {
        const desc = opt.description ? ` — ${opt.description}` : "";
        parts.push(`  • ${opt.label}${desc}`);
      }
    }
  }

  return parts.length > 0
    ? `The agent needs your input to proceed:\n\n${parts.join("\n")}`
    : "The agent needs your input to proceed.";
}
