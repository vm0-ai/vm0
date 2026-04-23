import { command, computed, state } from "ccstate";
import type { VoiceChatCandidateTask } from "@vm0/core";
import {
  startVoiceChatCandidate$,
  endVoiceChatCandidate$,
  vccLastUserMessage$,
  vccLastAssistantMessage$,
  vccTaskFeed$,
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

// Subtitle computeds mirror the per-role local state maintained by the
// voice-chat-candidate signal module. Those states are set directly in
// `appendItem$` after each successful DB write, so re-rendering is driven
// purely by the user's and Talker's finalized turns — no server roundtrip.
export const lastUserMessage$ = vccLastUserMessage$;
export const lastAgentMessage$ = vccLastAssistantMessage$;

/**
 * Task cards shown in voice mode — only in-flight work. The server returns
 * active plus recently-finished tasks so the Talker has context, but the UI
 * drops `done` and `failed` so the list reads as a live working queue.
 */
export const agentChatPendingTasks$ = computed(
  async (get): Promise<VoiceChatCandidateTask[]> => {
    const tasks = await get(vccTaskFeed$);
    return tasks.filter((t) => {
      return t.status !== "done" && t.status !== "failed";
    });
  },
);
