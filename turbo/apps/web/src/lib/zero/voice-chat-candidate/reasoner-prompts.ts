export const CONVERSATION_SECTION = "CONVERSATION";

export const REASONER_SYSTEM_PROMPT = `You are the Reasoner for a voice chat session. A separate Talker agent speaks to the user in real time; the Talker is a small speech-to-speech model with limited reasoning. Your job is to maintain a compact conversation summary the Talker can rely on each turn.

The Talker gets the task board (in-flight tasks, recently finished, lifecycle events) straight from the database — you do NOT narrate task state, counts, or progress. Leave all of that to the DB-backed task board.

You emit exactly one section — the conversation summary — using the marker below. Plain text, no markdown, no JSON, no code fences. Emit the marker and a blank line if there is nothing to say yet.

---${CONVERSATION_SECTION}---
Short summary of the non-task conversation state. Use these labels, one line each, omit empty ones:
  User: identity / background / preferences (stable across turns)
  Focus: the big thing the user is trying to accomplish right now
  Decided: bullet list of choices/constraints the user has already locked in — so Talker does not re-ask them
  Open: bullet list of unanswered questions, unfulfilled Talker promises, or ambiguities the user hasn't resolved — these are conversation-level loose ends, NOT live tasks (tasks are on the DB-backed board and you should ignore them here)
  Entities: shorthand references (not tasks) the user and Talker keep returning to (files, PRs, people)
  Style: current tone / pacing / any correction the user made to Talker
Keep each label to one short line (Decided / Open / Entities may use a short comma-separated list). Do not narrate tasks.

Return only this one section. No preamble, no explanations.`;

interface ItemForReasoner {
  seq: number;
  role: string;
  content: string | null;
  createdAt: string;
}

interface TaskForReasoner {
  id: string;
  status: string;
  prompt: string;
  resultText: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function buildReasonerUserPrompt(params: {
  agentSystemPrompt: string;
  priorConversationSummary: string | null;
  transcript: ItemForReasoner[];
  tasks: TaskForReasoner[];
}): string {
  const agentSlot = params.agentSystemPrompt.trim() || "(none)";
  const priorConversation = params.priorConversationSummary?.trim() || "(none)";

  const transcriptSlot =
    params.transcript.length === 0
      ? "(none)"
      : params.transcript
          .map((i) => {
            return `[${i.seq}] ${i.role}: ${i.content ?? ""}`;
          })
          .join("\n");

  // Tasks are included for grounding only — so the reasoner can mention
  // user intents / decisions tied to tasks in the conversation summary. It
  // MUST NOT restate counts or lifecycles; the DB-backed board owns that.
  const tasksSlot =
    params.tasks.length === 0
      ? "(none)"
      : params.tasks
          .map((t) => {
            const parts = [
              `[${t.id}] status=${t.status}`,
              `prompt: ${t.prompt}`,
            ];
            if (t.resultText) parts.push(`result: ${t.resultText}`);
            if (t.error) parts.push(`error: ${t.error}`);
            return parts.join("\n  ");
          })
          .join("\n\n");

  return [
    `Agent system prompt:\n${agentSlot}`,
    `Prior conversation summary:\n${priorConversation}`,
    `Full conversation transcript:\n${transcriptSlot}`,
    `Tasks this session (for grounding only — DO NOT summarize these):\n${tasksSlot}`,
  ].join("\n\n");
}
