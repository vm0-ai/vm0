import { command, computed, state } from "ccstate";
import type { VoiceChatTask } from "@vm0/core";
import {
  startVoiceChat$,
  endVoiceChat$,
  voiceChatLastUserMessage$,
  voiceChatLastAssistantMessage$,
  voiceChatTaskFeed$,
} from "../voice-chat/voice-chat-session.ts";

type VoiceMode = "off" | "on";

const internalVoiceMode$ = state<VoiceMode>("off");

export const agentChatVoiceMode$ = computed((get) => {
  return get(internalVoiceMode$);
});

/**
 * Flip voice mode on and begin the WebRTC / Ably handshake. The UI reflects
 * "connecting" via `voiceChatStatus$` until `startVoiceChat$` resolves.
 * Callers in the views layer should detach this promise via `detach(...)` so
 * the click handler returns immediately.
 */
export const enterAgentChatVoiceMode$ = command(
  async ({ set }, agentId: string, signal: AbortSignal) => {
    set(internalVoiceMode$, "on");
    await set(startVoiceChat$, agentId, signal);
  },
);

/**
 * Flip voice mode off and tear down the WebRTC / mic / Ably loop. The server
 * session row is left alone — next entry resumes via get-or-create.
 */
export const exitAgentChatVoiceMode$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(internalVoiceMode$, "off");
    await set(endVoiceChat$, signal);
  },
);

// Subtitle computeds mirror the per-role local state maintained by the
// voice-chat signal module. Those states are set directly in
// `appendItem$` after each successful DB write, so re-rendering is driven
// purely by the user's and Talker's finalized turns — no server roundtrip.
export const lastUserMessage$ = voiceChatLastUserMessage$;
export const lastAgentMessage$ = voiceChatLastAssistantMessage$;

/**
 * Task cards shown in voice mode — only in-flight work. The server returns
 * active plus recently-finished tasks so the Talker has context, but the UI
 * drops `done` and `failed` so the list reads as a live working queue.
 */
export const agentChatPendingTasks$ = computed(
  async (get): Promise<VoiceChatTask[]> => {
    const tasks = await get(voiceChatTaskFeed$);
    return tasks.filter((t) => {
      return t.status !== "done" && t.status !== "failed";
    });
  },
);
