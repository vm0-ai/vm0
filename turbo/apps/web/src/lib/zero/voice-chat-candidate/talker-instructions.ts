import "server-only";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import type { featureCandidateVoiceChatSessions } from "../../../db/schema/voice-chat-candidate";
import { buildFinishedTasksFullText } from "./build-finished-tasks";
import { buildRecentTaskLogs } from "./build-recent-task-logs";

const TALKER_INSTRUCTIONS_BASE = `
You are Zero, vm0's AI workspace assistant. You are speaking with the user in real time through voice.

## Tools

Call create_task(prompt) when the user asks for something that requires action beyond conversation — code, data lookups, external systems like GitHub or Slack, file operations, or any task that needs tool use. Include all relevant details in the prompt.

After calling create_task, acknowledge naturally:
- "Let me look into that."
- "I'll check on that for you."
- "Give me a moment to work on that."

Do NOT say "I can't do that." You CAN do it — it just takes a moment.

## Receiving task results

When you receive a message starting with [Task ...], it is the result of a task you created. Incorporate the information naturally. Use your own voice — do not read it verbatim.

## Communication style

- Keep responses concise and natural. You are speaking, not writing.
- No markdown, bullet points, or code blocks.
- Be warm and conversational.
`.trim();

type SessionRow = typeof featureCandidateVoiceChatSessions.$inferSelect;

interface TalkerContext {
  conversationSummary: string | null;
  workingTasksSummary: string | null;
  finishedTasksFullText: string;
  recentTaskLogs: string;
}

function composeTalkerInstructions(ctx: TalkerContext): string {
  const parts: string[] = [TALKER_INSTRUCTIONS_BASE];
  const conversation = ctx.conversationSummary?.trim() ?? "";
  const working = ctx.workingTasksSummary?.trim() ?? "";
  const finished = ctx.finishedTasksFullText.trim();
  const recent = ctx.recentTaskLogs.trim();
  if (conversation) parts.push(`## Conversation context\n${conversation}`);
  if (working) parts.push(`## Tasks in flight\n${working}`);
  if (finished) parts.push(`## Recently finished tasks\n${finished}`);
  if (recent) parts.push(`## Recent task activity\n${recent}`);
  return parts.join("\n\n");
}

function countTalkerInstructionTokens(instructions: string): number {
  return encode(instructions).length;
}

export async function buildTalkerPayload(session: SessionRow): Promise<{
  recentTaskLogs: string;
  finishedTasksFullText: string;
  talkerInstructions: string;
  talkerInstructionTokens: number;
}> {
  const [recentTaskLogs, finishedTasksFullText] = await Promise.all([
    buildRecentTaskLogs(session.id),
    buildFinishedTasksFullText(session.id),
  ]);
  const talkerInstructions = composeTalkerInstructions({
    conversationSummary: session.conversationSummary,
    workingTasksSummary: session.workingTasksSummary,
    finishedTasksFullText,
    recentTaskLogs,
  });
  const talkerInstructionTokens =
    countTalkerInstructionTokens(talkerInstructions);
  return {
    recentTaskLogs,
    finishedTasksFullText,
    talkerInstructions,
    talkerInstructionTokens,
  };
}
