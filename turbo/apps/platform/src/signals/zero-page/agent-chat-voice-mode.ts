import { command, computed, state } from "ccstate";
import {
  startVoiceChatCandidate$,
  endVoiceChatCandidate$,
  vccConversationItems$,
  vccTasksById$,
} from "../voice-chat-candidate/voice-chat-candidate-session.ts";

type VoiceMode = "off" | "on";

const internalVoiceMode$ = state<VoiceMode>("off");

export const agentChatVoiceMode$ = computed((get) => {
  return get(internalVoiceMode$);
});

/**
 * Flip voice mode on and begin the WebRTC / Ably handshake. The UI reflects
 * "connecting" via `vccStatus$` until `startVoiceChatCandidate$` resolves.
 * Callers in the views layer should detach this promise via `detach(...)` so
 * the click handler returns immediately.
 */
export const enterAgentChatVoiceMode$ = command(
  async ({ set }, agentId: string, signal: AbortSignal) => {
    set(internalVoiceMode$, "on");
    await set(startVoiceChatCandidate$, agentId, signal);
  },
);

/**
 * Flip voice mode off and tear down the WebRTC / mic / Ably loop. The server
 * session row is left alone — next entry resumes via get-or-create.
 */
export const exitAgentChatVoiceMode$ = command(({ set }) => {
  set(internalVoiceMode$, "off");
  set(endVoiceChatCandidate$);
});

export const lastUserMessage$ = computed((get) => {
  const entries = get(vccConversationItems$);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    if (
      entry.kind === "server" &&
      entry.item.role === "user" &&
      (entry.item.content ?? "").trim().length > 0
    ) {
      return entry.item.content ?? "";
    }
    if (entry.kind === "streaming" && entry.role === "user") {
      return entry.content;
    }
  }
  return "";
});

export const lastAgentMessage$ = computed((get) => {
  const entries = get(vccConversationItems$);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    if (
      entry.kind === "server" &&
      entry.item.role === "assistant" &&
      (entry.item.content ?? "").trim().length > 0
    ) {
      return entry.item.content ?? "";
    }
    if (entry.kind === "streaming" && entry.role === "assistant") {
      return entry.content;
    }
  }
  return "";
});

/**
 * Task cards shown in voice mode: pending / queued / running only. Done and
 * failed tasks are intentionally hidden.
 */
export const agentChatPendingTasks$ = computed((get) => {
  const tasksById = get(vccTasksById$);
  return Object.values(tasksById)
    .filter((task) => {
      return (
        task.status === "pending" ||
        task.status === "queued" ||
        task.status === "running"
      );
    })
    .sort((a, b) => {
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
});
