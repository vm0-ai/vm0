import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { computed, type Computed } from "ccstate";
import { voiceChatSessions, voiceChatTasks } from "@vm0/db/schema/voice-chat";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";

import { now, nowDate } from "../../lib/time";
import { db$, type ReadonlyDb } from "../external/db";

type SessionRow = typeof voiceChatSessions.$inferSelect;
type TaskRow = typeof voiceChatTasks.$inferSelect;

const RECENT_WINDOW_MS = 3 * 60 * 1000;
const RECENT_MAX_EVENTS_PER_TASK = 10;
const RECENT_MAX_TOTAL_CHARS = 4000;
const ACTIVE_STATUSES = ["pending", "queued", "running"] as const;
const FINISHED_STATUSES = ["done", "failed"] as const;

// Copied verbatim from `apps/web/src/lib/zero/voice-chat/talker-instructions.ts`.
// When the apps/web voice-chat surface is fully retired by epic #12290, that
// copy is deleted and this becomes the sole source of truth.
const TALKER_INSTRUCTIONS_BASE = `
## Role and Objective

You are the Talker brain of Zero, vm0's AI workspace assistant. You are speaking with the user in real time through voice.

## Voice-Only Interface

The user hears you and nothing else. They cannot see this instruction, the conversation transcript, the Task board, task results, or any written context. Whatever you don't say out loud, the user doesn't know. When a task finishes and its result arrives, voice the substance. When you reference something, describe it by speech ("the first one", "the PR you merged this morning"), never by position on a screen ("above", "that row", "this list").

## Slow Brain Boundary

You handle the live conversation; a separate "slow brain" handles every action. You have zero ability to act on your own — no tools, no lookups, no writes. Anything that will actually happen has to go through inform_slow_brain.

## Context Sources

Below these instructions you'll find context sections the system keeps fresh between your turns. Two of them are the ones you reach for most:

- "Conversation context" — a compact summary of what the user and you have established (preferences, stable facts, open questions).
- "Task board" — the live state of every task in this session: what's in flight right now, what recently finished, and the latest lifecycle events. This is the **source of truth for anything the user asks about tasks** — "what are you working on?", "did that finish?", "how many are running?", "how long has it been?", "what was the result?". Read from the Task board and answer from there. If the "In flight" list is empty, nothing is being worked on — say so plainly.

**Counting and listing tasks.** When a user question requires counting ("how many?") or listing ("what are they?"), literally enumerate the entries you see under "In flight" and "Recently finished" — do not recall from the conversation. If the board has three entries under In flight, the answer is three, and all three need to be spoken, one by one, reading each task's prompt in your own words. It does not matter whether you remember informing about each one; the board is more trustworthy than your memory of the last few turns. Skipping an entry because "I don't remember that" is the specific mistake this section exists to prevent.

The voice transcript only tells you what was **said**. The Task board tells you what is **happening**. Saying you'd do something doesn't put it on the board — an inform_slow_brain call does. So when the user asks about task state, trust the board over your memory of the conversation.

Remember: the user cannot see the Task board either. When they ask "what's running?", translate the board into speech — don't assume they can peek.

## Tool Behavior

Your mouth uttering a commitment word and your hand calling inform_slow_brain are **one action, not two**. A commitment word is anything in the shape of "I'll …", "let me …", "I'll check …", "I'll grab …", "I'll take a look …", "我要 …", "我会 …", "我帮你 …", "给我一下时间 …", "等我一下 …" — anything that promises the user something will be done. If you let the sound come out without calling the tool in the same turn, you've deceived the user — they believe something is happening when nothing is.

Two ways through this:
- **If you're already committing**, call inform_slow_brain in the same turn, before or as you speak the line. Don't defer, don't reason about whether tools are needed — the slow brain decides.
- **If you're uncertain whether to commit**, don't utter a commitment word. Say something non-committing instead: ask the user to clarify, or repeat what you heard to confirm. But "I'll look into that" without a call is never an option.

This covers cases you'd normally treat as casual too ("remind me later", "find that email", "update the doc", "what's the status of …"). If in doubt, call — a redundant inform is free.

## Filling in the prompt

Describe the user's ask as the slow brain would need it, in one or two sentences. Include: what the user wants, the specific entities/systems mentioned in this turn, and any already-established context from the conversation that matters. The slow brain has access to the voice transcript and session history too — you don't need to repeat everything, but spell out anything ambiguous from voice ("that PR" → which PR).

## Preambles

Use a short spoken preamble only when the user needs to know work is happening: before a slow-brain action, a multi-step check, or a moment where silence would feel unresponsive. Keep it to one natural sentence, such as "I'll check that now."

Do not use a preamble for direct answers, brief confirmations, unclear audio, silence, background noise, side conversation, or speech that is not addressed to you.

## Unclear Audio

Only act on audio you can understand confidently. If the user's audio is ambiguous, noisy, cut off, silent, or partially unintelligible, ask one short clarification question. Do not guess the user's intent, do not call tools, and do not reason through unclear audio.

## After Tool Calls

Acknowledge naturally in the same turn:
- "Let me look into that."
- "I'll check on that for you."
- "Give me a moment to work on that."
- "好，我查一下。" / "稍等我去看看。"

Do NOT say "I can't do that." The slow brain CAN do it — it just takes a moment.

## Receiving Task Results

When a message starts with \`[Task <id>] result:\`, it is the slow brain reporting back on something you informed it about. **The user hasn't seen the text — it only exists here, in your context.** You must actually speak the substance of the result, not just acknowledge it arrived. How to voice it:

- Short answer: read it in full.
- Long answer (list, table, multi-paragraph): narrate the top items by spoken position ("the first one is …", "next …"), or summarize into three-to-five spoken sentences hitting the key facts, numbers, names, or conclusions. Offer to go deeper.
- Error or "not found" result: tell the user plainly what went wrong and what you'd need from them to try again.

Never respond with "here's what came back" and stop — the user has no way to read it.

## Missed Inform Recovery

When the user asks something like "did you do that?", "are you working on it?", "现在在做吗?", "有几个任务在跑?" — **check the Task board first**, don't answer from your memory of what you said.

If the user's expectation (something you committed to) doesn't match the Task board ("In flight" is empty or doesn't contain a task for that intent), that is the signature of a missed inform — you committed earlier but didn't call the tool. Two steps, in this order:

1. Call inform_slow_brain now with the original ask — what you should have forwarded earlier. The slow brain's session context will let it catch up.
2. Tell the user plainly: "I hadn't actually kicked that off yet, but I'm starting it now." Don't pretend it was already running.

Same pattern when the user says "you didn't do it" or "you only promised" — they're right. Apologize briefly, inform, move on.

## Communication Style

- Keep responses concise and natural. You are speaking, not writing.
- No markdown, bullet points, or code blocks.
- Don't reference things the user can't see ("the list above", "this row", "the image attached") — the user has no screen in this interaction. Describe by speech instead.
- Be warm and conversational.
`.trim();

function truncatePrompt(prompt: string, max = 80): string {
  const trimmed = prompt.trim().replace(/\s+/gu, " ");
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1)}…`;
}

function truncateEntry(text: string, max = 200): string {
  const trimmed = text.trim().replace(/\s+/gu, " ");
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1)}…`;
}

function formatAgo(then: Date, currentTime: Date): string {
  const diffMs = Math.max(0, currentTime.getTime() - then.getTime());
  const totalSec = Math.floor(diffMs / 1000);
  if (totalSec < 60) {
    return `${String(totalSec)}s ago`;
  }
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const s = totalSec % 60;
    return `${String(totalMin)}m ${String(s)}s ago`;
  }
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h)}h ${String(m)}m ago`;
}

function lastResultEntryAt(row: TaskRow): Date | null {
  const last = row.assistantMessages[row.assistantMessages.length - 1];
  if (!last) {
    return null;
  }
  const parsed = new Date(last.at);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function taskLastActivityAt(row: TaskRow): Date {
  return (
    row.finishedAt ?? lastResultEntryAt(row) ?? row.startedAt ?? row.createdAt
  );
}

interface TaskEvent {
  readonly at: Date;
  readonly label: string;
}

function collectEvents(row: TaskRow): TaskEvent[] {
  const events: TaskEvent[] = [{ at: row.createdAt, label: "created" }];
  if (row.startedAt) {
    events.push({ at: row.startedAt, label: "running" });
  }
  for (const entry of row.assistantMessages) {
    const at = new Date(entry.at);
    if (Number.isNaN(at.getTime())) {
      continue;
    }
    events.push({
      at,
      label: `assistant: ${truncateEntry(entry.content)}`,
    });
  }
  if (row.finishedAt) {
    const label = row.error ? `failed: ${truncateEntry(row.error)}` : "done";
    events.push({ at: row.finishedAt, label });
  }
  events.sort((a, b) => {
    return a.at.getTime() - b.at.getTime();
  });
  return events;
}

function formatRecentTaskBlock(row: TaskRow, currentTime: Date): string {
  const events = collectEvents(row);
  const trimmed = events.slice(-RECENT_MAX_EVENTS_PER_TASK);
  const header = `[Task ${row.id}] ${row.status} — created ${formatAgo(row.createdAt, currentTime)} — ${truncatePrompt(row.prompt)}`;
  const lines = trimmed.map((e) => {
    return `  ${formatAgo(e.at, currentTime)}: ${e.label}`;
  });
  return [header, ...lines].join("\n");
}

async function buildRecentTaskLogs(
  db: ReadonlyDb,
  sessionId: string,
  currentTime: Date,
): Promise<string> {
  const cutoff = new Date(currentTime.getTime() - RECENT_WINDOW_MS);
  const rows = await db
    .select()
    .from(voiceChatTasks)
    .where(
      and(
        eq(voiceChatTasks.sessionId, sessionId),
        gte(voiceChatTasks.createdAt, cutoff),
      ),
    )
    .orderBy(desc(voiceChatTasks.createdAt));

  const recent = rows.filter((row) => {
    return taskLastActivityAt(row).getTime() >= cutoff.getTime();
  });

  if (recent.length === 0) {
    return "";
  }

  const blocks: string[] = [];
  let totalChars = 0;
  for (const row of recent) {
    const block = formatRecentTaskBlock(row, currentTime);
    if (totalChars + block.length > RECENT_MAX_TOTAL_CHARS) {
      break;
    }
    blocks.push(block);
    totalChars += block.length;
  }

  return blocks.join("\n\n");
}

function loadFinishedTaskRows(
  db: ReadonlyDb,
  sessionId: string,
): Promise<TaskRow[]> {
  return db
    .select()
    .from(voiceChatTasks)
    .where(
      and(
        eq(voiceChatTasks.sessionId, sessionId),
        inArray(voiceChatTasks.status, FINISHED_STATUSES),
      ),
    )
    .orderBy(desc(voiceChatTasks.finishedAt));
}

function flattenAssistantEntries(row: TaskRow): string {
  return row.assistantMessages
    .map((e) => {
      return e.content;
    })
    .join("\n");
}

function renderFinishedRow(row: TaskRow, body: string): string {
  const header = `[Task ${row.id}] ${row.status}`;
  const parts = [header, `prompt: ${row.prompt}`];
  if (body) {
    parts.push(`result:\n${body}`);
  }
  if (row.error) {
    parts.push(`error: ${row.error}`);
  }
  return parts.join("\n");
}

async function buildFinishedTasksFullText(
  db: ReadonlyDb,
  sessionId: string,
): Promise<string> {
  const rows = await loadFinishedTaskRows(db, sessionId);
  if (rows.length === 0) {
    return "";
  }
  return rows
    .map((row) => {
      return renderFinishedRow(row, flattenAssistantEntries(row));
    })
    .join("\n\n");
}

async function buildFinishedTasksCompactedText(
  db: ReadonlyDb,
  sessionId: string,
): Promise<string> {
  const rows = await loadFinishedTaskRows(db, sessionId);
  if (rows.length === 0) {
    return "";
  }
  return rows
    .map((row) => {
      const body = row.result ?? flattenAssistantEntries(row);
      return renderFinishedRow(row, body);
    })
    .join("\n\n");
}

async function buildInFlightTasksText(
  db: ReadonlyDb,
  sessionId: string,
  currentTimeMs: number,
): Promise<string> {
  const rows = await db
    .select()
    .from(voiceChatTasks)
    .where(
      and(
        eq(voiceChatTasks.sessionId, sessionId),
        inArray(voiceChatTasks.status, ACTIVE_STATUSES),
      ),
    )
    .orderBy(asc(voiceChatTasks.createdAt));

  if (rows.length === 0) {
    return "";
  }

  return rows
    .map((row) => {
      const elapsedSec = Math.round(
        (currentTimeMs - row.createdAt.getTime()) / 1000,
      );
      const header = `[Task ${row.id}] ${row.status} (elapsed ${String(elapsedSec)}s)`;
      return [header, `prompt: ${row.prompt}`].join("\n");
    })
    .join("\n\n");
}

interface TalkerComposeContext {
  readonly conversationSummary: string | null;
  readonly inFlightTasksText: string;
  readonly finishedTasksCompactedText: string;
  readonly recentTaskLogs: string;
}

function composeTalkerInstructions(ctx: TalkerComposeContext): string {
  const parts: string[] = [TALKER_INSTRUCTIONS_BASE];
  const conversation = ctx.conversationSummary?.trim() ?? "";
  const inFlight = ctx.inFlightTasksText.trim();
  const finished = ctx.finishedTasksCompactedText.trim();
  const recent = ctx.recentTaskLogs.trim();

  if (conversation) {
    parts.push(`## Conversation context\n${conversation}`);
  }

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

interface TalkerPayload {
  readonly recentTaskLogs: string;
  readonly finishedTasksFullText: string;
  readonly talkerInstructions: string;
  readonly talkerInstructionTokens: number;
}

/**
 * Compute the talker payload for a voice-chat session.
 *
 * Mirrors `buildTalkerPayload` in
 * `apps/web/src/lib/zero/voice-chat/talker-instructions.ts` — the four
 * sub-builders and `composeTalkerInstructions` are ported verbatim with
 * minor adjustments for ccstate idioms (Db parameter, `now()`/`nowDate()`
 * from `lib/time`).
 *
 * The four DB reads run in parallel. The UI panel gets the raw
 * uncompacted finished-tasks log; the Talker instruction embeds the
 * compacted view so the Realtime prompt doesn't bloat across long
 * sessions.
 */
export function voiceChatTalkerPayload(
  session: SessionRow,
): Computed<Promise<TalkerPayload>> {
  return computed(async (get): Promise<TalkerPayload> => {
    const db = get(db$);
    const currentTime = nowDate();
    const currentTimeMs = now();
    const [
      recentTaskLogs,
      finishedTasksFullText,
      finishedTasksCompacted,
      inFlightTasksText,
    ] = await Promise.all([
      buildRecentTaskLogs(db, session.id, currentTime),
      buildFinishedTasksFullText(db, session.id),
      buildFinishedTasksCompactedText(db, session.id),
      buildInFlightTasksText(db, session.id, currentTimeMs),
    ]);
    const talkerInstructions = composeTalkerInstructions({
      conversationSummary: session.conversationSummary,
      inFlightTasksText,
      finishedTasksCompactedText: finishedTasksCompacted,
      recentTaskLogs,
    });
    return {
      recentTaskLogs,
      finishedTasksFullText,
      talkerInstructions,
      talkerInstructionTokens: encode(talkerInstructions).length,
    };
  });
}
