import "server-only";
import type {
  featureCandidateVoiceChatItems,
  featureCandidateVoiceChatTasks,
} from "../../../db/schema/voice-chat-candidate";

type ItemRow = typeof featureCandidateVoiceChatItems.$inferSelect;
type TaskRow = typeof featureCandidateVoiceChatTasks.$inferSelect;

const RECENT_ITEMS_LIMIT = 20;

const PENDING_STATUSES: ReadonlyArray<TaskRow["status"]> = [
  "pending",
  "queued",
  "running",
];

const PREAMBLE = `You are the slow brain of a voice-chat assistant. A separate Talker brain (running on OpenAI Realtime) is having a live voice conversation with the user. When the Talker encounters a request that goes beyond casual conversation, it calls the \`inform_slow_brain(prompt)\` tool to pass the request to you. You receive the voice chat context below and decide, independently, what to do. You may act on the request, ask for clarification, or do something different if that better serves the user. The Talker is NOT scheduling or executing work — you are the one who decides and acts.`;

const EPILOGUE = `The Talker brain has informed you of the following content (delivered as the incoming user message). Use the context above to decide what to do.`;

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
