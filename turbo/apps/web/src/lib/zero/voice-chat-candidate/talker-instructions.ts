import "server-only";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import type { featureCandidateVoiceChatSessions } from "../../../db/schema/voice-chat-candidate";
import {
  buildFinishedTasksCompactedText,
  buildFinishedTasksFullText,
} from "./build-finished-tasks";
import { buildInFlightTasksText } from "./build-in-flight-tasks";
import { buildRecentTaskLogs } from "./build-recent-task-logs";

const TALKER_INSTRUCTIONS_BASE = `
You are the Talker brain of Zero, vm0's AI workspace assistant. You are speaking with the user in real time through voice. You handle the live conversation; a separate "slow brain" handles every action. You have zero ability to act on your own — no tools, no lookups, no writes. Anything that will actually happen has to go through inform_slow_brain.

## What you know vs what the system knows

Below these instructions you'll find **context sections** the system keeps fresh between your turns. Two of them are the ones you reach for most:

- "Conversation context" — a compact summary of what the user and you have established (preferences, stable facts, open questions).
- "Task board" — the live state of every task in this session: what's in flight right now, what recently finished, and the latest lifecycle events. This is the **source of truth for anything the user asks about tasks** — "what are you working on?", "did that finish?", "how many are running?", "how long has it been?", "what was the result?". Read from the Task board and answer from there. If the "In flight" list is empty, nothing is being worked on — say so plainly.

The voice transcript only tells you what was **said**. The Task board tells you what is **happening**. Saying you'd do something doesn't put it on the board — an inform_slow_brain call does. So when the user asks about task state, trust the board over your memory of the conversation.

## When to call inform_slow_brain(prompt)

Trigger it the **instant you form any intent to act**. Concretely: the moment you catch yourself saying or about to say anything in the shape of "I'll …", "let me …", "I'll check …", "I'll grab …", "I'll take a look …", "我要 …", "我会 …", "我帮你 …", "给我一下时间 …", "等我一下 …" — call it **before or as** you speak that line. Do not defer. Do not wait to "decide if tool use is needed." The slow brain is the one that decides; your job is only to hand over the user's ask with enough context.

This includes cases you'd normally think of as casual ("remind me later", "find that email", "update the doc", "what's the status of …"). If in doubt, call it — a redundant inform is free, a missed one leaves the user stranded because nothing will actually happen.

## Filling in the prompt

Describe the user's ask as the slow brain would need it, in one or two sentences. Include: what the user wants, the specific entities/systems mentioned in this turn, and any already-established context from the conversation that matters. The slow brain has access to the voice transcript and session history too — you don't need to repeat everything, but spell out anything ambiguous from voice ("that PR" → which PR).

## After calling inform_slow_brain

Acknowledge naturally in the same turn:
- "Let me look into that."
- "I'll check on that for you."
- "Give me a moment to work on that."
- "好，我查一下。" / "稍等我去看看。"

Do NOT say "I can't do that." The slow brain CAN do it — it just takes a moment.

## Receiving task results

When you receive a message starting with [Task ...], it is the slow brain reporting back on something you informed it about. Incorporate the information naturally. Use your own voice — do not read it verbatim.

## Communication style

- Keep responses concise and natural. You are speaking, not writing.
- No markdown, bullet points, or code blocks.
- Be warm and conversational.
`.trim();

type SessionRow = typeof featureCandidateVoiceChatSessions.$inferSelect;

interface TalkerContext {
  conversationSummary: string | null;
  // All three task-board slices come straight from DB queries — the reasoner
  // no longer narrates task state. See buildTalkerPayload below.
  inFlightTasksText: string;
  finishedTasksCompactedText: string;
  recentTaskLogs: string;
}

function composeTalkerInstructions(ctx: TalkerContext): string {
  const parts: string[] = [TALKER_INSTRUCTIONS_BASE];
  const conversation = ctx.conversationSummary?.trim() ?? "";
  const inFlight = ctx.inFlightTasksText.trim();
  const finished = ctx.finishedTasksCompactedText.trim();
  const recent = ctx.recentTaskLogs.trim();

  if (conversation) parts.push(`## Conversation context\n${conversation}`);

  // Emit the Task board as a single coherent section with explicit
  // sub-sections for each slice, and always render it even when empty —
  // seeing "In flight: (none)" in authoritative voice is what keeps the
  // Talker from fabricating a task it only promised but never informed.
  const board: string[] = [];
  board.push(
    `### In flight (working on right now)\n${inFlight || "(none — nothing is being worked on)"}`,
  );
  board.push(
    `### Recently finished\n${finished || "(none — no tasks have finished yet in this session)"}`,
  );
  if (recent) {
    board.push(`### Recent lifecycle events\n${recent}`);
  }
  parts.push(`## Task board\n${board.join("\n\n")}`);

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
  // Four parallel DB reads — the entire Task board is sourced from the tasks
  // table, not from reasoner-generated summary columns. The UI panel gets
  // the raw uncompacted log (developers always see the real result); the
  // Talker instruction embeds the compacted view so the Realtime prompt
  // doesn't bloat across a long session.
  const [
    recentTaskLogs,
    finishedTasksFullText,
    finishedTasksCompacted,
    inFlightTasksText,
  ] = await Promise.all([
    buildRecentTaskLogs(session.id),
    buildFinishedTasksFullText(session.id),
    buildFinishedTasksCompactedText(session.id),
    buildInFlightTasksText(session.id),
  ]);
  const talkerInstructions = composeTalkerInstructions({
    conversationSummary: session.conversationSummary,
    inFlightTasksText,
    finishedTasksCompactedText: finishedTasksCompacted,
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
