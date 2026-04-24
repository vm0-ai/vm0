import "server-only";
import type {
  voiceChatItems,
  voiceChatTasks,
} from "../../../db/schema/voice-chat";

type ItemRow = typeof voiceChatItems.$inferSelect;
type TaskRow = typeof voiceChatTasks.$inferSelect;

const RECENT_ITEMS_LIMIT = 20;

const PENDING_STATUSES: ReadonlyArray<TaskRow["status"]> = [
  "pending",
  "queued",
  "running",
];

const PREAMBLE = `You are the slow brain of a voice-chat assistant. A separate Talker brain (running on OpenAI Realtime) is having a live voice conversation with the user. Whenever the Talker picks up something it thinks might need attention, it calls the \`inform_slow_brain(prompt)\` tool to forward it to you.

**This is an inform, not a request.** The Talker is not directing your actions — it is surfacing a signal from a noisy voice stream. You have the full session context below (conversation, pending work, recently finished work). Based on that, you decide what is actually useful: act, decline, clarify, or just point at existing work. The Talker does not know what you already know.

Voice is messy and repetitive. The same real intent often arrives as several informs across turns — rephrased, retranscribed, repeated, or re-confirmed. Two informs in a row may be the same thing, or may be different things that sound the same. Always let the session context — especially the pending-tasks and recently-finished-tasks sections — be your primary evidence for what is actually going on, rather than the inform text alone.

Whatever you return is what the Talker voices back to the user, so keep it concise and substantive.`;

const EPILOGUE = `The Talker brain has informed you of the following (delivered as the incoming user message). Use the context above to decide what — if anything — to do, and return something the Talker can voice back to the user.`;

function formatItems(items: ItemRow[]): string {
  const recent = items.slice(-RECENT_ITEMS_LIMIT);
  if (recent.length === 0) return "(none)";
  return recent
    .map((i) => {
      return `[${i.seq}] ${i.role}: ${i.content ?? ""}`;
    })
    .join("\n");
}

function formatPendingTasks(tasks: TaskRow[]): string {
  const pending = tasks.filter((t) => {
    return PENDING_STATUSES.includes(t.status);
  });
  if (pending.length === 0) return "(none)";
  return pending
    .map((t) => {
      return `[${t.id}] status=${t.status} prompt: ${t.prompt}`;
    })
    .join("\n");
}

function formatFinishedTasks(tasks: TaskRow[]): string {
  const finished = tasks.filter((t) => {
    return t.status === "done" || t.status === "failed";
  });
  if (finished.length === 0) return "(none)";
  return finished
    .map((t) => {
      const header = `[${t.id}] status=${t.status} prompt: ${t.prompt}`;
      const parts: string[] = [header];
      const body =
        t.result ??
        t.assistantMessages
          .map((e) => {
            return e.content;
          })
          .join("\n");
      if (body) parts.push(`result:\n${body}`);
      if (t.error) parts.push(`error: ${t.error}`);
      return parts.join("\n");
    })
    .join("\n\n");
}

export function buildSlowBrainAppendSystemPrompt(params: {
  agentSystemPrompt: string;
  items: ItemRow[];
  sessionTasks: TaskRow[];
}): string {
  const agentPrompt = params.agentSystemPrompt.trim() || "(none)";
  return [
    PREAMBLE,
    `[Voice chat agent system prompt]\n${agentPrompt}`,
    `[Last ${String(RECENT_ITEMS_LIMIT)} transcript items]\n${formatItems(params.items)}`,
    `[Pending tasks in this voice chat session]\n${formatPendingTasks(params.sessionTasks)}`,
    `[Recently finished tasks in this voice chat session]\n${formatFinishedTasks(params.sessionTasks)}`,
    EPILOGUE,
  ].join("\n\n");
}
