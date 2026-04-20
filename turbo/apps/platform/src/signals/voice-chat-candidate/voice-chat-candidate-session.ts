// TODO(#10334): split large commands to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { command, computed, state } from "ccstate";
import {
  FeatureSwitchKey,
  zeroVoiceChatCandidateContract,
  type VoiceChatCandidateItem,
  type VoiceChatCandidateItemRole,
  type VoiceChatCandidateTask,
} from "@vm0/core";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { defaultAgentId$ } from "../agent.ts";
import { resetSignal, throwIfAbort, onDomEventFn, setLoop } from "../utils.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { logger } from "../log.ts";

const L = logger("VoiceChatCandidate");

type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

const HEARTBEAT_INTERVAL_MS = 30_000;

// Hardcoded Talker model per epic #10297. No model picker in candidate v1.
const TALKER_MODEL = "gpt-realtime-mini";

// Hardcoded per epic #10297 parity with voice-chat-session.ts. Follow-up tracked
// in a separate issue to route through env() alongside the sibling implementation.
const OPENAI_REALTIME_BASE_URL = "https://api.openai.com/v1/realtime";

const HANDS_FREE_VAD_CONFIG = {
  type: "semantic_vad",
  eagerness: "medium",
} as const;

const SESSION_TOOLS = [
  {
    type: "function",
    name: "create_task",
    description:
      "Spawn a background task when the user asks for something that requires action beyond conversation.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The task prompt to spawn.",
        },
      },
      required: ["prompt"],
    },
  },
] as const;

const TALKER_INSTRUCTIONS_BASE = `
You are Zero, vm0's AI workspace assistant. You are speaking with the user in real time through voice.

## Tools

Call create_task(prompt) when the user asks for something that requires action beyond conversation — code, data lookups, external systems like GitHub or Slack, file operations, or any task that needs tool use. Include all relevant details in the prompt.

After calling create_task, acknowledge naturally:
- "Let me look into that."
- "I'll check on that for you."
- "Give me a moment to work on that."

Do NOT say "I can't do that." You CAN do it — it just takes a moment.

## Receiving task results

When you receive a message starting with [Task ...], it is the result of a task you created. Incorporate the information naturally. Use your own voice — do not read it verbatim.

## Communication style

- Keep responses concise and natural. You are speaking, not writing.
- No markdown, bullet points, or code blocks.
- Be warm and conversational.
`.trim();

function composeInstructions(context: string): string {
  if (!context.trim()) {
    return TALKER_INSTRUCTIONS_BASE;
  }
  return `${TALKER_INSTRUCTIONS_BASE}\n\n## Context\n${context}`;
}

function shortPrompt(prompt: string, max = 60): string {
  const trimmed = prompt.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1)}…`;
}

function ablyTopic(sessionId: string): string {
  return `voice-chat-candidate:${sessionId}`;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const internalStatus$ = state<ConnectionStatus>("idle");
const internalSessionId$ = state<string | null>(null);
const internalItems$ = state<VoiceChatCandidateItem[]>([]);
const internalMaxSeq$ = state<number>(0);
const internalTasksByCallId$ = state<Record<string, VoiceChatCandidateTask>>(
  {},
);
const internalTasksById$ = state<Record<string, VoiceChatCandidateTask>>({});
const internalContext$ = state<string>("");
const internalContextVersion$ = state<number>(0);
const internalStreamingAssistant$ = state<{
  responseId: string;
  itemId: string | null;
  text: string;
} | null>(null);
const internalPendingUserItemId$ = state<string | null>(null);
const internalMuted$ = state<boolean>(false);
const internalError$ = state<string | null>(null);
const internalPc$ = state<RTCPeerConnection | null>(null);
const internalDc$ = state<RTCDataChannel | null>(null);
const internalStream$ = state<MediaStream | null>(null);
const internalAudioEl$ = state<HTMLAudioElement | null>(null);
const internalWakeLock$ = state<WakeLockSentinel | null>(null);
const internalParentSignal$ = state<AbortSignal | null>(null);

const resetSessionSignal$ = resetSignal();

// ---------------------------------------------------------------------------
// Exported computed getters
// ---------------------------------------------------------------------------

export const vccStatus$ = computed((get) => {
  return get(internalStatus$);
});

export const vccError$ = computed((get) => {
  return get(internalError$);
});

export const vccMuted$ = computed((get) => {
  return get(internalMuted$);
});

export const vccEnabled$ = computed(async (get) => {
  const features = await get(featureSwitch$);
  return features[FeatureSwitchKey.VoiceChat] ?? false;
});

export const vccAgentId$ = computed(async (get) => {
  return await get(defaultAgentId$);
});

export const vccSessionId$ = computed((get) => {
  return get(internalSessionId$);
});

export const vccTasksById$ = computed((get) => {
  return get(internalTasksById$);
});

type StreamingItem = {
  kind: "streaming";
  key: string;
  role: "user" | "assistant";
  content: string;
};

type ServerItem = {
  kind: "server";
  key: string;
  item: VoiceChatCandidateItem;
};

type VccConversationEntry = StreamingItem | ServerItem;

/**
 * Merged stream: finalized server items (ordered by seq) followed by any
 * in-flight streaming text from the active Realtime turn. Server items are
 * the source of truth; streaming text is a per-turn UX nicety.
 */
export const vccConversationItems$ = computed((get) => {
  const items = get(internalItems$);
  const streamingAssistant = get(internalStreamingAssistant$);
  const pendingUserItemId = get(internalPendingUserItemId$);

  const seenRealtimeIds = new Set(
    items.map((i) => {
      return i.realtimeItemId;
    }),
  );

  const sorted = [...items].sort((a, b) => {
    return a.seq - b.seq;
  });

  const entries: VccConversationEntry[] = sorted.map((item) => {
    return { kind: "server", key: item.id, item };
  });

  if (pendingUserItemId && !seenRealtimeIds.has(pendingUserItemId)) {
    entries.push({
      kind: "streaming",
      key: `streaming-user-${pendingUserItemId}`,
      role: "user",
      content: "…",
    });
  }

  if (
    streamingAssistant &&
    streamingAssistant.text.trim() !== "" &&
    !(
      streamingAssistant.itemId &&
      seenRealtimeIds.has(streamingAssistant.itemId)
    )
  ) {
    entries.push({
      kind: "streaming",
      key: `streaming-assistant-${streamingAssistant.responseId}`,
      role: "assistant",
      content: streamingAssistant.text,
    });
  }

  return entries;
});

// ---------------------------------------------------------------------------
// Item store helpers
// ---------------------------------------------------------------------------

function upsertItem(
  prev: VoiceChatCandidateItem[],
  next: VoiceChatCandidateItem,
): VoiceChatCandidateItem[] {
  const existing = prev.findIndex((i) => {
    return i.id === next.id || i.realtimeItemId === next.realtimeItemId;
  });
  if (existing === -1) {
    return [...prev, next];
  }
  const updated = [...prev];
  updated[existing] = next;
  return updated;
}

// ---------------------------------------------------------------------------
// Internal commands
// ---------------------------------------------------------------------------

const appendItem$ = command(
  async (
    { get, set },
    role: VoiceChatCandidateItemRole,
    content: string,
    realtimeItemId: string,
    signal: AbortSignal,
  ) => {
    const sid = get(internalSessionId$);
    if (!sid) {
      return;
    }
    const createClient = get(zeroClient$);
    const client = createClient(zeroVoiceChatCandidateContract);
    const res = await accept(
      client.appendItem({
        params: { id: sid },
        body: { role, content, realtimeItemId },
      }),
      [200, 400, 401, 404],
      { toast: false },
    );
    signal.throwIfAborted();
    if (res.status !== 200) {
      L.warn("appendItem failed", { status: res.status, sid });
      return;
    }
    const item = res.body.item;
    set(internalItems$, (prev) => {
      return upsertItem(prev, item);
    });
    set(internalMaxSeq$, (prev) => {
      return Math.max(prev, item.seq);
    });
  },
);

const handleCreateTask$ = command(
  async (
    { get, set },
    callId: string,
    argsJson: string,
    signal: AbortSignal,
  ) => {
    const sid = get(internalSessionId$);
    const dc = get(internalDc$);
    if (!sid || !dc || dc.readyState !== "open") {
      return;
    }

    let parsed: { prompt?: unknown };
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse can throw on malformed Realtime function args; we recover with an error output so Talker doesn't hang on the pending call
    try {
      parsed = JSON.parse(argsJson) as { prompt?: unknown };
    } catch (error) {
      throwIfAbort(error);
      L.warn("Failed to parse create_task args", { callId, argsJson });
      sendFunctionOutput(dc, callId, "Task creation failed: invalid args.");
      return;
    }

    const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
    if (!prompt.trim()) {
      sendFunctionOutput(dc, callId, "Task creation failed: empty prompt.");
      return;
    }

    const createClient = get(zeroClient$);
    const client = createClient(zeroVoiceChatCandidateContract);
    const res = await accept(
      client.createTask({
        params: { id: sid },
        body: { prompt, callId },
      }),
      [200, 400, 401, 404],
      { toast: false },
    );
    signal.throwIfAborted();

    if (res.status !== 200) {
      L.warn("createTask failed", { status: res.status, sid });
      sendFunctionOutput(
        dc,
        callId,
        "Task creation failed. Please try again or rephrase.",
      );
      return;
    }

    const task = res.body.task;
    set(internalTasksByCallId$, (prev) => {
      return { ...prev, [task.callId]: task };
    });
    set(internalTasksById$, (prev) => {
      return { ...prev, [task.id]: task };
    });
    sendFunctionOutput(
      dc,
      callId,
      `Task '${shortPrompt(prompt)}' queued. I'll report back when it's ready.`,
    );
  },
);

function sendFunctionOutput(
  dc: RTCDataChannel,
  callId: string,
  output: string,
): void {
  // Epic decision: no `response.create` — the next user turn absorbs the
  // function_call_output. This keeps Talker quiet while a task runs.
  dc.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output,
      },
    }),
  );
}

type RealtimeDCEvent = {
  type: string;
  item_id?: string;
  item?: { id: string; type: string; role?: string };
  transcript?: string;
  response_id?: string;
  delta?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
};

const handleConversationItemCreated$ = command(
  ({ get, set }, event: RealtimeDCEvent) => {
    if (event.item?.role === "user" && event.item.type === "message") {
      set(internalPendingUserItemId$, event.item.id);
      return;
    }
    if (
      event.item?.role === "assistant" &&
      event.item.type === "message" &&
      event.response_id
    ) {
      const streaming = get(internalStreamingAssistant$);
      if (streaming && streaming.responseId === event.response_id) {
        set(internalStreamingAssistant$, {
          ...streaming,
          itemId: event.item.id,
        });
      }
    }
  },
);

const handleAudioTranscriptDelta$ = command(
  ({ get, set }, event: RealtimeDCEvent) => {
    const deltaText = event.delta ?? "";
    const responseId = event.response_id ?? "";
    if (!responseId) {
      return;
    }
    const current = get(internalStreamingAssistant$);
    if (current && current.responseId === responseId) {
      set(internalStreamingAssistant$, {
        ...current,
        text: current.text + deltaText,
      });
    } else {
      set(internalStreamingAssistant$, {
        responseId,
        itemId: event.item_id ?? null,
        text: deltaText,
      });
    }
  },
);

const handleAudioTranscriptDone$ = command(
  async ({ get, set }, event: RealtimeDCEvent, signal: AbortSignal) => {
    const current = get(internalStreamingAssistant$);
    const finalText = event.transcript ?? current?.text ?? "";
    const responseId = event.response_id ?? current?.responseId ?? "";
    const itemId =
      event.item_id ??
      current?.itemId ??
      (responseId ? `${responseId}:${finalText.length.toString()}` : null);
    set(internalStreamingAssistant$, null);
    if (finalText.trim() && itemId) {
      await set(appendItem$, "assistant", finalText, itemId, signal);
    }
  },
);

const handleInputAudioTranscriptionCompleted$ = command(
  async ({ set }, event: RealtimeDCEvent, signal: AbortSignal) => {
    if (event.transcript && event.item_id) {
      set(internalPendingUserItemId$, null);
      await set(appendItem$, "user", event.transcript, event.item_id, signal);
    }
  },
);

const handleDCMessage$ = command(
  async ({ set }, data: string, signal: AbortSignal) => {
    const event = JSON.parse(data) as RealtimeDCEvent;

    switch (event.type) {
      case "conversation.item.created": {
        set(handleConversationItemCreated$, event);
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        await set(handleInputAudioTranscriptionCompleted$, event, signal);
        break;
      }
      case "response.audio_transcript.delta": {
        set(handleAudioTranscriptDelta$, event);
        break;
      }
      case "response.audio_transcript.done": {
        await set(handleAudioTranscriptDone$, event, signal);
        break;
      }
      case "response.function_call_arguments.done": {
        if (event.call_id && event.name === "create_task" && event.arguments) {
          await set(handleCreateTask$, event.call_id, event.arguments, signal);
        }
        break;
      }
    }
  },
);

// ---------------------------------------------------------------------------
// WebRTC setup
// ---------------------------------------------------------------------------

const setupWebRTC$ = command(
  async (
    { get, set },
    stream: MediaStream,
    token: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const pc = new RTCPeerConnection();
    set(internalPc$, pc);

    for (const track of stream.getAudioTracks()) {
      pc.addTrack(track, stream);
    }

    const audioEl = new Audio();
    audioEl.autoplay = true;
    set(internalAudioEl$, audioEl);

    pc.addEventListener("track", (e) => {
      if (e.streams[0]) {
        audioEl.srcObject = e.streams[0];
      }
    });

    const dc = pc.createDataChannel("oai-events");
    set(internalDc$, dc);

    dc.addEventListener("open", () => {
      const context = get(internalContext$);
      dc.send(
        JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            instructions: composeInstructions(context),
            input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
            input_audio_noise_reduction: { type: "far_field" },
            turn_detection: HANDS_FREE_VAD_CONFIG,
            tools: SESSION_TOOLS,
          },
        }),
      );
      set(internalStatus$, "connected");
    });

    dc.addEventListener(
      "message",
      onDomEventFn((ev: MessageEvent) => {
        return set(handleDCMessage$, ev.data as string, signal);
      }),
    );

    dc.addEventListener("close", () => {
      if (get(internalStatus$) === "connected") {
        set(internalStatus$, "disconnected");
      }
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      if (
        pc.iceConnectionState === "failed" ||
        pc.iceConnectionState === "disconnected"
      ) {
        if (get(internalStatus$) === "connected") {
          set(internalStatus$, "disconnected");
        }
      }
    });

    const offer = await pc.createOffer();
    signal.throwIfAborted();
    await pc.setLocalDescription(offer);
    signal.throwIfAborted();

    const sdpRes = await globalThis.fetch(
      `${OPENAI_REALTIME_BASE_URL}?model=${TALKER_MODEL}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      },
    );
    signal.throwIfAborted();

    if (!sdpRes.ok) {
      set(internalError$, "Failed to connect to OpenAI Realtime API");
      set(internalStatus$, "error");
      return false;
    }

    const answerSdp = await sdpRes.text();
    signal.throwIfAborted();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    signal.throwIfAborted();
    return true;
  },
);

// ---------------------------------------------------------------------------
// Heartbeat + Ably loops
// ---------------------------------------------------------------------------

const startHeartbeat$ = command(async ({ get }, signal: AbortSignal) => {
  await setLoop(
    async () => {
      const sid = get(internalSessionId$);
      if (!sid) {
        return true;
      }
      const createClient = get(zeroClient$);
      const client = createClient(zeroVoiceChatCandidateContract);
      await accept(
        client.heartbeat({ params: { id: sid }, body: {} }),
        [200, 401, 404],
        { toast: false },
      );
      return false;
    },
    HEARTBEAT_INTERVAL_MS,
    signal,
  );
});

const refreshInstructionsIfChanged$ = command(({ get }, context: string) => {
  const dc = get(internalDc$);
  if (!dc || dc.readyState !== "open") {
    return;
  }
  dc.send(
    JSON.stringify({
      type: "session.update",
      session: { instructions: composeInstructions(context) },
    }),
  );
});

const startAblyLoop$ = command(
  async ({ set }, sessionId: string, signal: AbortSignal) => {
    const pollBody$ = command(async ({ get, set }, loopSignal: AbortSignal) => {
      const sid = get(internalSessionId$);
      if (!sid) {
        return true;
      }
      const createClient = get(zeroClient$);
      const client = createClient(zeroVoiceChatCandidateContract);

      const maxSeq = get(internalMaxSeq$);
      const itemsRes = await accept(
        client.readItems({
          params: { id: sid },
          query: { after: maxSeq },
        }),
        [200, 401, 404],
        { toast: false },
      );
      loopSignal.throwIfAborted();

      if (itemsRes.status === 200 && itemsRes.body.items.length > 0) {
        const newItems = itemsRes.body.items;
        set(internalItems$, (prev) => {
          let next = prev;
          for (const item of newItems) {
            next = upsertItem(next, item);
          }
          return next;
        });
        const lastSeq = newItems.reduce((acc, item) => {
          return Math.max(acc, item.seq);
        }, maxSeq);
        set(internalMaxSeq$, lastSeq);
      }

      const sessionRes = await accept(
        client.getSession({ params: { id: sid } }),
        [200, 401, 404],
        { toast: false },
      );
      loopSignal.throwIfAborted();

      if (sessionRes.status === 200) {
        const session = sessionRes.body.session;
        const prevVersion = get(internalContextVersion$);
        const nextContext = session.context ?? "";
        if (session.contextVersion > prevVersion) {
          set(internalContext$, nextContext);
          set(internalContextVersion$, session.contextVersion);
          set(refreshInstructionsIfChanged$, nextContext);
        }
        if (session.status !== "active") {
          set(internalStatus$, "disconnected");
          return true;
        }
      }
      return false;
    });

    await set(setAblyLoop$, ablyTopic(sessionId), pollBody$, signal);
  },
);

// ---------------------------------------------------------------------------
// Wake lock (parity with non-candidate voice-chat UX)
// ---------------------------------------------------------------------------

const MAX_WAKE_LOCK_REACQUIRE_ATTEMPTS = 3;

const acquireWakeLock$ = command(async ({ set }, signal: AbortSignal) => {
  if (!("wakeLock" in navigator)) {
    return;
  }

  let pending = false;
  let reacquireCount = 0;

  const requestAndTrack = async (): Promise<void> => {
    if (pending) {
      return;
    }
    if (document.visibilityState !== "visible") {
      return;
    }
    pending = true;
    let lock: WakeLockSentinel | undefined;
    // eslint-disable-next-line no-restricted-syntax -- wakeLock.request rejects if the document is hidden; treat as non-critical
    try {
      lock = await navigator.wakeLock.request("screen");
    } catch {
      pending = false;
      return;
    }
    pending = false;
    if (signal.aborted) {
      lock.release().catch(() => {
        return undefined;
      });
      return;
    }
    set(internalWakeLock$, lock);
    lock.addEventListener("release", () => {
      if (
        !signal.aborted &&
        reacquireCount < MAX_WAKE_LOCK_REACQUIRE_ATTEMPTS
      ) {
        reacquireCount++;
        requestAndTrack().catch(() => {
          return undefined;
        });
      }
    });
  };

  signal.throwIfAborted();

  const onVisibilityChange = (): void => {
    if (document.visibilityState === "visible" && !signal.aborted) {
      reacquireCount = 0;
      requestAndTrack().catch(() => {
        return undefined;
      });
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  signal.addEventListener("abort", () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });

  await requestAndTrack();
});

const releaseWakeLock$ = command(({ get, set }) => {
  const lock = get(internalWakeLock$);
  if (lock) {
    lock.release().catch(() => {
      return undefined;
    });
    set(internalWakeLock$, null);
  }
});

// ---------------------------------------------------------------------------
// Public commands
// ---------------------------------------------------------------------------

export const startVoiceChatCandidate$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const status = get(internalStatus$);
    if (status === "connecting" || status === "connected") {
      return;
    }

    set(internalStatus$, "connecting");
    set(internalError$, null);
    set(internalItems$, []);
    set(internalMaxSeq$, 0);
    set(internalTasksByCallId$, {});
    set(internalTasksById$, {});
    set(internalContext$, "");
    set(internalContextVersion$, 0);
    set(internalStreamingAssistant$, null);
    set(internalPendingUserItemId$, null);
    set(internalMuted$, false);
    set(internalSessionId$, null);
    set(internalParentSignal$, signal);

    const sessionSignal = set(resetSessionSignal$, signal);

    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();

    if (!agentId) {
      set(internalError$, "No agent selected");
      set(internalStatus$, "error");
      return;
    }

    const createClient = get(zeroClient$);
    const client = createClient(zeroVoiceChatCandidateContract);

    const sessionRes = await accept(
      client.createSession({ body: { agentId } }),
      [200, 400, 401, 403],
      { toast: false },
    );
    signal.throwIfAborted();

    if (sessionRes.status !== 200) {
      set(internalError$, sessionRes.body.error.message);
      set(internalStatus$, "error");
      return;
    }

    const session = sessionRes.body.session;
    set(internalSessionId$, session.id);
    set(internalContext$, session.context ?? "");
    set(internalContextVersion$, session.contextVersion);

    const tokenRes = await accept(
      client.token({ body: { model: TALKER_MODEL } }),
      [200, 401, 403, 500, 503],
      { toast: false },
    );
    signal.throwIfAborted();

    if (tokenRes.status !== 200) {
      set(internalError$, tokenRes.body.error.message);
      set(internalStatus$, "error");
      return;
    }

    const { client_secret: clientSecret } = tokenRes.body;

    let stream: MediaStream;
    // eslint-disable-next-line no-restricted-syntax -- getUserMedia can reject on permission denial or missing hardware
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      throwIfAbort(error);
      set(
        internalError$,
        "Microphone access denied. Please allow microphone access.",
      );
      set(internalStatus$, "error");
      return;
    }
    signal.throwIfAborted();
    set(internalStream$, stream);

    const ok = await set(
      setupWebRTC$,
      stream,
      clientSecret.value,
      sessionSignal,
    );
    signal.throwIfAborted();
    if (!ok) {
      return;
    }

    await set(acquireWakeLock$, sessionSignal);
    signal.throwIfAborted();

    await Promise.allSettled([
      set(startHeartbeat$, sessionSignal),
      set(startAblyLoop$, session.id, sessionSignal),
    ]);
  },
);

export const endVoiceChatCandidate$ = command(({ get, set }) => {
  const sid = get(internalSessionId$);

  if (sid) {
    const createClient = get(zeroClient$);
    const client = createClient(zeroVoiceChatCandidateContract);
    accept(
      client.endSession({ params: { id: sid }, body: {} }),
      [200, 401, 404],
      { toast: false },
    ).catch(() => {
      return undefined;
    });
  }

  set(resetSessionSignal$);
  set(releaseWakeLock$);

  const dc = get(internalDc$);
  if (dc) {
    dc.close();
    set(internalDc$, null);
  }

  const pc = get(internalPc$);
  if (pc) {
    pc.close();
    set(internalPc$, null);
  }

  const stream = get(internalStream$);
  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    set(internalStream$, null);
  }

  const audioEl = get(internalAudioEl$);
  if (audioEl) {
    audioEl.pause();
    audioEl.srcObject = null;
    set(internalAudioEl$, null);
  }

  set(internalSessionId$, null);
  set(internalItems$, []);
  set(internalMaxSeq$, 0);
  set(internalTasksByCallId$, {});
  set(internalTasksById$, {});
  set(internalContext$, "");
  set(internalContextVersion$, 0);
  set(internalStreamingAssistant$, null);
  set(internalPendingUserItemId$, null);
  set(internalParentSignal$, null);
  set(internalStatus$, "idle");
});

export const toggleVoiceChatCandidateMute$ = command(({ get, set }) => {
  const stream = get(internalStream$);
  if (!stream) {
    return;
  }
  const track = stream.getAudioTracks()[0];
  if (!track) {
    return;
  }
  const wasMuted = get(internalMuted$);
  track.enabled = wasMuted;
  set(internalMuted$, !wasMuted);
});
