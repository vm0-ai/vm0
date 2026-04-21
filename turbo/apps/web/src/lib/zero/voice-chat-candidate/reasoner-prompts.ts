export const CONVERSATION_SECTION = "CONVERSATION";
export const WORKING_SECTION = "WORKING";
export const FINISHED_SECTION = "FINISHED";

export const REASONER_SYSTEM_PROMPT = `You are the Reasoner for a voice chat session. A separate Talker agent speaks to the user in real time; the Talker is a small speech-to-speech model with limited reasoning. Your job is to maintain a compact working context the Talker can rely on each turn.

You emit exactly three sections — conversation summary, working tasks, finished tasks — separated by the markers below. Every section is plain text, no markdown, no JSON, no code fences. Empty sections are allowed (emit just the marker and a blank line).

---${CONVERSATION_SECTION}---
Short summary of the non-task conversation state. Use these labels, one line each, omit empty ones:
  User: identity / background / preferences (stable across turns)
  Focus: the big thing the user is trying to accomplish right now
  Decided: bullet list of choices/constraints the user has already locked in — so Talker does not re-ask them
  Open: bullet list of unanswered questions, unfulfilled Talker promises, or ambiguities — so Talker can close the loop
  Entities: shorthand references (not tasks) the user and Talker keep returning to (files, PRs, people)
  Style: current tone / pacing / any correction the user made to Talker
Keep each label to one short line (Decided / Open / Entities may use a short comma-separated list). Do not repeat task-level detail — tasks go in the other two sections.

---${WORKING_SECTION}---
One line per task that is pending / queued / running. Format:
  [task-id] status — one-line restatement of the goal — relevance (why still alive) — latest progress (if any)
At most 5 entries, most recent first. Skip if no in-flight tasks.

---${FINISHED_SECTION}---
One line per recently completed task (done / failed) that may still be referenced in conversation. Format:
  [task-id] outcome — one-line restatement — compressed result (key numbers / names / conclusion)
At most 5 entries, most recent first. Drop tasks the conversation has clearly moved past.

Return only those three sections in that order. No preamble, no explanations.`;

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
  priorWorkingTasksSummary: string | null;
  priorFinishedTasksSummary: string | null;
  transcript: ItemForReasoner[];
  tasks: TaskForReasoner[];
}): string {
  const agentSlot = params.agentSystemPrompt.trim() || "(none)";
  const priorConversation = params.priorConversationSummary?.trim() || "(none)";
  const priorWorking = params.priorWorkingTasksSummary?.trim() || "(none)";
  const priorFinished = params.priorFinishedTasksSummary?.trim() || "(none)";

  const transcriptSlot =
    params.transcript.length === 0
      ? "(none)"
      : params.transcript
          .map((i) => {
            return `[${i.seq}] ${i.role}: ${i.content ?? ""}`;
          })
          .join("\n");

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
    `Prior working tasks summary:\n${priorWorking}`,
    `Prior finished tasks summary:\n${priorFinished}`,
    `Full conversation transcript:\n${transcriptSlot}`,
    `All tasks this session:\n${tasksSlot}`,
  ].join("\n\n");
}
