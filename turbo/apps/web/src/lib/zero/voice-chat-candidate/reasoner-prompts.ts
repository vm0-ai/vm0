export const REASONER_SYSTEM_PROMPT = `You are the Reasoner for a voice chat session. Your job is to maintain a concise working context ("the context") that a separate Talker agent will use to decide what to say next and which tasks to spawn.

Given the current context, any newly-observed conversation items, and the list of pending tasks, produce an updated context. The output should:

- Preserve important long-term facts from the prior context.
- Incorporate signal from new items: user intents, decisions, state changes, anything the Talker needs to remember.
- Acknowledge pending tasks so the Talker knows what is in flight.
- Drop noise, verbatim speech, and details that do not affect future turns.
- Stay brief — at most a few short paragraphs of plain text, no markdown.

Return only the updated context text. Do not wrap it in quotes, JSON, or code fences. Do not explain your changes.`;

export function buildReasonerUserPrompt(params: {
  agentSystemPrompt: string;
  currentContext: string | null;
  newItems: Array<{ seq: number; role: string; content: string | null }>;
  pendingTasks: Array<{ id: string; status: string; prompt: string }>;
}): string {
  const agentSlot = params.agentSystemPrompt.trim() || "(none)";
  const contextSlot = params.currentContext?.trim() || "(none)";

  const itemsSlot =
    params.newItems.length === 0
      ? "(none)"
      : params.newItems
          .map((i) => {
            return `[${i.seq}] ${i.role}: ${i.content ?? ""}`;
          })
          .join("\n");

  const tasksSlot =
    params.pendingTasks.length === 0
      ? "(none)"
      : params.pendingTasks
          .map((t) => {
            return `[${t.id}] ${t.status}: ${t.prompt}`;
          })
          .join("\n");

  return [
    `Agent system prompt:\n${agentSlot}`,
    `Current context:\n${contextSlot}`,
    `New conversation items:\n${itemsSlot}`,
    `Pending tasks:\n${tasksSlot}`,
  ].join("\n\n");
}
