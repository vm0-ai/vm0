import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@vm0/core";
import { fetch$ } from "../fetch.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { resetSignal, throwIfAbort, onDomEventFn, setLoop } from "../utils.ts";

type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  id: string;
}

interface ContextEvent {
  seq: number;
  source: string;
  type: string;
  content: string | null;
  createdAt: string;
}

function updateLastTranscriptEntry(
  prev: TranscriptEntry[],
  id: string,
  text: string,
): TranscriptEntry[] {
  const updated = [...prev];
  const last = updated[updated.length - 1];
  if (last && last.id === id) {
    updated[updated.length - 1] = { ...last, text };
  }
  return updated;
}

function upsertUserTranscript(
  prev: TranscriptEntry[],
  itemId: string,
  text: string,
): TranscriptEntry[] {
  const idx = prev.findIndex((e) => {
    return e.id === itemId;
  });
  if (idx !== -1) {
    const updated = [...prev];
    updated[idx] = { ...updated[idx]!, text };
    return updated;
  }
  return [...prev, { role: "user" as const, text, id: itemId }];
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const POLL_INTERVAL_MS = 2000;
const REALTIME_MODEL = "gpt-realtime-1.5";

const SESSION_TOOLS = [
  {
    type: "function",
    name: "read_shared_context",
    description:
      "Check for updates from your slow-thinking self. Call this before responding to the user to see if there are new directives, progress updates, or results from your background thinking.",
    parameters: {
      type: "object",
      properties: {
        after_seq: {
          type: "number",
          description:
            "Only return events with sequence number greater than this value. Use this to get only new events since your last read.",
        },
      },
    },
  },
] as const;

const TALKER_INSTRUCTIONS = `
You are Zero, vm0's AI workspace assistant. You are speaking with the user in real time through voice.

You have two thinking modes:
- Fast mode (you): real-time voice conversation. You listen, respond, and keep the dialogue flowing naturally.
- Slow mode (your background self): deep work, tool use, and execution. It observes the conversation and works autonomously.

The shared context is your shared memory with your slow-thinking self. Before responding to the user, always call read_shared_context to check for updates.

When you read shared context, look for events with source "slow-brain":

1. If you find a directive (type "directive"): incorporate its content naturally into your response. Do not read it verbatim — use your own voice and phrasing. The directive provides the substance; you provide the delivery.

2. If your slow self is working (type "thinking-progress"): acknowledge it naturally. For example: "Let me think about that more carefully..." or "I'm looking into that right now..."

3. If there is a result (type "thinking-result"): summarize the result conversationally for the user.

4. If there are no new updates from your slow self: respond on your own. Handle casual conversation, ask clarifying questions, and be a warm conversational partner.

Communication style:
- Keep responses concise and natural. You are speaking, not writing.
- Do not use markdown formatting, bullet points, or code blocks.
- Be warm and conversational, like a helpful colleague.
- When the user asks for something that needs tools or deep work, reassure them naturally: "Let me look into that" or "I'll work on that."
`.trim();

function logContextEvent(
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  sessionId: string | null,
  source: string,
  type: string,
  content: string,
): void {
  if (!sessionId) {
    return;
  }
  void fetchFn(`/api/zero/voice-chat/${sessionId}/context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, type, content }),
  }).then(
    () => {
      return undefined;
    },
    () => {
      return undefined;
    },
  );
}

function formatInjectionMessage(event: ContextEvent): string {
  const prefixes: Record<string, string> = {
    directive: "[Your background thinking completed]",
    "thinking-progress": "[Your background self is working]",
    "thinking-result": "[Background result]",
    observation: "[Background observation]",
  };
  const label = prefixes[event.type] ?? `[Background update - ${event.type}]`;
  return `${label} ${event.content ?? ""}`.trim();
}

// --- Internal state ---

const internalStatus$ = state<ConnectionStatus>("idle");
const internalTranscript$ = state<TranscriptEntry[]>([]);
const internalEvents$ = state<ContextEvent[]>([]);
const internalMuted$ = state(false);
const internalError$ = state<string | null>(null);
const internalSessionId$ = state<string | null>(null);
const internalLastSeq$ = state(0);
const internalCurrentAssistant$ = state<{
  id: string;
  text: string;
} | null>(null);
const internalPc$ = state<RTCPeerConnection | null>(null);
const internalDc$ = state<RTCDataChannel | null>(null);
const internalStream$ = state<MediaStream | null>(null);
const internalAudioEl$ = state<HTMLAudioElement | null>(null);

const resetSessionSignal$ = resetSignal();

// --- Exported computed ---

export const vcStatus$ = computed((get) => {
  return get(internalStatus$);
});
export const vcTranscript$ = computed((get) => {
  return get(internalTranscript$);
});
export const vcEvents$ = computed((get) => {
  return get(internalEvents$);
});
export const vcMuted$ = computed((get) => {
  return get(internalMuted$);
});
export const vcError$ = computed((get) => {
  return get(internalError$);
});
export const vcEnabled$ = computed(async (get) => {
  const features = await get(featureSwitch$);
  return features[FeatureSwitchKey.VoiceChat] ?? false;
});
export const vcAgentId$ = computed(async (get) => {
  return await get(currentChatAgentId$);
});

// --- Internal commands ---

const handleFnCall$ = command(
  async (
    { get },
    callId: string,
    name: string,
    args: string,
    signal: AbortSignal,
  ) => {
    const fetchFn = get(fetch$);
    const sid = get(internalSessionId$);
    if (!sid) {
      return;
    }
    signal.throwIfAborted();

    let result: string;

    if (name === "read_shared_context") {
      const parsed = JSON.parse(args) as { after_seq?: number };
      const afterParam =
        parsed.after_seq !== undefined ? `?after=${parsed.after_seq}` : "";
      const res = await fetchFn(
        `/api/zero/voice-chat/${sid}/context${afterParam}`,
      );
      signal.throwIfAborted();
      const data = (await res.json()) as { events: ContextEvent[] };
      signal.throwIfAborted();
      result = JSON.stringify(data.events);
    } else {
      result = JSON.stringify({ error: `Unknown function: ${name}` });
    }

    const dc = get(internalDc$);
    if (!dc || dc.readyState !== "open") {
      return;
    }

    dc.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: result,
        },
      }),
    );
    dc.send(JSON.stringify({ type: "response.create" }));
  },
);

const handleDCMessage$ = command(
  async ({ get, set }, data: string, sessionSignal: AbortSignal) => {
    const event = JSON.parse(data) as {
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

    switch (event.type) {
      case "conversation.item.created": {
        if (event.item?.role === "user" && event.item.type === "message") {
          set(internalTranscript$, (prev) => {
            return [
              ...prev,
              {
                role: "user" as const,
                text: "...",
                id: event.item!.id,
              },
            ];
          });
        }
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        if (event.transcript) {
          const itemId = event.item_id ?? crypto.randomUUID();
          set(internalTranscript$, (prev) => {
            return upsertUserTranscript(prev, itemId, event.transcript!);
          });

          // Auto-log user speech to shared context (fire-and-forget)
          logContextEvent(
            get(fetch$),
            get(internalSessionId$),
            "user",
            "speech",
            event.transcript,
          );
        }
        break;
      }

      case "response.audio_transcript.delta": {
        const deltaText = event.delta ?? "";
        const current = get(internalCurrentAssistant$);
        if (current && current.id === event.response_id) {
          const updatedText = current.text + deltaText;
          set(internalCurrentAssistant$, { id: current.id, text: updatedText });
          set(internalTranscript$, (prev) => {
            return updateLastTranscriptEntry(prev, current.id, updatedText);
          });
        } else {
          const id = event.response_id ?? crypto.randomUUID();
          set(internalCurrentAssistant$, { id, text: deltaText });
          set(internalTranscript$, (prev) => {
            return [
              ...prev,
              { role: "assistant" as const, text: deltaText, id },
            ];
          });
        }
        break;
      }

      case "response.audio_transcript.done": {
        const current = get(internalCurrentAssistant$);
        if (current) {
          const finalText = event.transcript ?? current.text;
          const finalId = current.id;
          set(internalCurrentAssistant$, null);
          set(internalTranscript$, (prev) => {
            const updated = [...prev];
            const idx = updated.findIndex((e) => {
              return e.id === finalId;
            });
            if (idx !== -1) {
              updated[idx] = { ...updated[idx]!, text: finalText };
            }
            return updated;
          });

          // Auto-log talker response to shared context (fire-and-forget)
          logContextEvent(
            get(fetch$),
            get(internalSessionId$),
            "talker",
            "response",
            finalText,
          );
        }
        break;
      }

      case "response.function_call_arguments.done": {
        if (event.call_id && event.name && event.arguments) {
          await set(
            handleFnCall$,
            event.call_id,
            event.name,
            event.arguments,
            sessionSignal,
          );
        }
        break;
      }
    }
  },
);

const injectSlowBrainEvents$ = command(
  ({ get, set }, events: ContextEvent[]) => {
    const dc = get(internalDc$);
    if (!dc || dc.readyState !== "open") {
      return;
    }

    const slowBrainEvents = events.filter((e) => {
      return e.source === "slow-brain" && e.content;
    });
    if (slowBrainEvents.length === 0) {
      return;
    }

    // Interrupt if model is mid-speech
    const current = get(internalCurrentAssistant$);
    if (current) {
      dc.send(JSON.stringify({ type: "response.cancel" }));
      set(internalCurrentAssistant$, null);
    }

    // Inject each event as a user message
    for (const event of slowBrainEvents) {
      dc.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: formatInjectionMessage(event) },
            ],
          },
        }),
      );
    }

    // Trigger model to respond to injected content
    dc.send(JSON.stringify({ type: "response.create" }));
  },
);

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
      dc.send(
        JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            instructions: TALKER_INSTRUCTIONS,
            input_audio_transcription: { model: "whisper-1" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.6,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
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
      `https://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`,
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

const startHeartbeat$ = command(async ({ get }, signal: AbortSignal) => {
  await setLoop(
    async (sig: AbortSignal) => {
      const sid = get(internalSessionId$);
      if (!sid) {
        return true;
      }

      const fetchFn = get(fetch$);
      await fetchFn(`/api/zero/voice-chat/${sid}/heartbeat`, {
        method: "POST",
        signal: sig,
      });
      return false;
    },
    HEARTBEAT_INTERVAL_MS,
    signal,
  );
});

const startPoll$ = command(async ({ get, set }, signal: AbortSignal) => {
  await setLoop(
    async (signal: AbortSignal) => {
      const sid = get(internalSessionId$);
      if (!sid) {
        return true;
      }

      const lastSeq = get(internalLastSeq$);
      const fetchFn = get(fetch$);
      const res = await fetchFn(
        `/api/zero/voice-chat/${sid}/context?after=${lastSeq}`,
        { signal },
      );

      if (!res.ok) {
        return false;
      }

      const data = (await res.json()) as { events: ContextEvent[] };
      signal.throwIfAborted();

      if (data.events.length > 0) {
        set(internalEvents$, (prev) => {
          return [...prev, ...data.events];
        });
        const lastEvent = data.events[data.events.length - 1];
        if (lastEvent) {
          set(internalLastSeq$, lastEvent.seq);
        }
        set(injectSlowBrainEvents$, data.events);
      }
      return false;
    },
    POLL_INTERVAL_MS,
    signal,
  );
});

// --- Exported commands ---
export const startVoiceChat$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (
      get(internalStatus$) === "connecting" ||
      get(internalStatus$) === "connected"
    ) {
      return;
    }

    set(internalStatus$, "connecting");
    set(internalError$, null);
    set(internalTranscript$, []);
    set(internalEvents$, []);
    set(internalMuted$, false);
    set(internalSessionId$, null);
    set(internalLastSeq$, 0);
    set(internalCurrentAssistant$, null);

    const sessionSignal = set(resetSessionSignal$, signal);

    const fetchFn = get(fetch$);
    const agentId = await get(currentChatAgentId$);
    signal.throwIfAborted();

    if (!agentId) {
      set(internalError$, "No agent selected");
      set(internalStatus$, "error");
      return;
    }

    const sessionRes = await fetchFn("/api/zero/voice-chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    signal.throwIfAborted();

    if (!sessionRes.ok) {
      const body = (await sessionRes.json()) as {
        error: { message: string };
      };
      signal.throwIfAborted();
      set(internalError$, body.error.message);
      set(internalStatus$, "error");
      return;
    }

    const { session } = (await sessionRes.json()) as {
      session: { id: string };
    };
    signal.throwIfAborted();
    set(internalSessionId$, session.id);

    const tokenRes = await fetchFn("/api/zero/voice-chat/token", {
      method: "POST",
    });
    signal.throwIfAborted();

    if (!tokenRes.ok) {
      const body = (await tokenRes.json()) as {
        error: { message: string };
      };
      signal.throwIfAborted();
      set(internalError$, body.error.message);
      set(internalStatus$, "error");
      return;
    }

    const { client_secret: clientSecret } = (await tokenRes.json()) as {
      client_secret: { value: string; expires_at: number };
    };
    signal.throwIfAborted();

    let stream: MediaStream;
    // eslint-disable-next-line no-restricted-syntax -- getUserMedia can fail due to permission denial or missing hardware
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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

    await Promise.allSettled([
      set(startHeartbeat$, sessionSignal),
      set(startPoll$, sessionSignal),
    ]);
  },
);

export const endVoiceChat$ = command(({ get, set }) => {
  const sid = get(internalSessionId$);
  const fetchFn = get(fetch$);

  // End session on server so it's no longer "active" in DB
  if (sid && fetchFn) {
    void fetchFn(`/api/zero/voice-chat/${sid}/end`, { method: "POST" }).then(
      () => {
        return undefined;
      },
      () => {
        return undefined;
      },
    );
  }

  set(resetSessionSignal$);

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
  set(internalStatus$, "idle");
});

export const toggleVoiceChatMute$ = command(({ get, set }) => {
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
