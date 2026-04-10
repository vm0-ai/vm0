import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@vm0/core";
import { fetch$ } from "../fetch.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { resetSignal, throwIfAbort, onDomEventFn, setLoop } from "../utils.ts";

type ConnectionStatus =
  | "idle"
  | "preparing"
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
    name: "request_slow_brain",
    description:
      "Send a task to your slow-brain for deep thinking, tool use, or execution. Use this when the user asks for something that requires code, data, APIs, file access, or any action beyond conversation. Your slow-brain will work on it and the result will be delivered to you automatically.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Clear description of what to do. Include relevant details from the conversation (PR numbers, file names, etc).",
        },
      },
      required: ["task"],
    },
  },
] as const;

const FAST_BRAIN_INSTRUCTIONS = `
You are Zero, vm0's AI workspace assistant. You are speaking with the user in real time through voice.

You can do everything. Some things you handle instantly — conversation, knowledge, opinions, brainstorming. Other things need a moment of deeper thinking — code, tools, data lookups, file access, external systems like GitHub, Slack, or APIs. For those, you delegate to your slow-brain using the request_slow_brain tool.

## When to delegate

Call request_slow_brain when the user asks you to DO something involving:
- Code: writing, reviewing, debugging, running tests
- Data: looking up PRs, issues, deployments, logs, metrics
- External systems: Slack, GitHub, email, APIs, databases
- File operations: reading, editing, creating files
- Any task that requires tool use or execution

Include all relevant details in the task description — PR numbers, file names, error messages, specific requests.

## After delegating

After calling request_slow_brain, acknowledge naturally:
- "Let me look into that."
- "I'll check on that for you."
- "Give me a moment to work on that."

Do NOT say "I can't do that" or "I don't have access to that." You CAN do it — it just takes a moment.

## When you are unsure

Never immediately say "I don't know" or "I can't do that." Instead, delegate to your slow-brain first:
- "Let me check on that."
- "Let me think about that for a moment."
- "Let me try to find out."

Only after your slow-brain responds can you tell the user that something is not possible or that you could not find an answer. Always try before giving up.

## Receiving results

When you receive a message starting with [Slow-brain...], it is from your slow-brain. Incorporate that information naturally into your response. Use your own voice — do not read it verbatim. The slow-brain message provides the substance; you provide the delivery.

## Communication style

- Keep responses concise and natural. You are speaking, not writing.
- Do not use markdown formatting, bullet points, or code blocks.
- Be warm and conversational, like a helpful colleague.
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
    directive: "[Slow-brain directive]",
    thinking: "[Slow-brain thinking]",
    observation: "[Slow-brain observation]",
  };
  const label = prefixes[event.type] ?? `[Slow-brain update - ${event.type}]`;
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
const internalPrompt$ = state<string | null>(null);

const meetingPromptInput$ = state("");

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
export const vcPrompt$ = computed((get) => {
  return get(internalPrompt$);
});
export const vcMeetingPromptInput$ = computed((get) => {
  return get(meetingPromptInput$);
});
export const setMeetingPromptInput$ = command(({ set }, value: string) => {
  set(meetingPromptInput$, value);
});

// --- Internal commands ---

const handleFnCall$ = command(
  (
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

    if (name === "request_slow_brain") {
      const parsed = JSON.parse(args) as { task: string };
      logContextEvent(
        fetchFn,
        sid,
        "fast-brain",
        "request-slow-brain",
        parsed.task,
      );
      result =
        "Request sent to your slow-brain. The result will be delivered to you automatically — no need to check.";
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

          // Auto-log fast-brain response to shared context (fire-and-forget)
          logContextEvent(
            get(fetch$),
            get(internalSessionId$),
            "fast-brain",
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
            instructions: FAST_BRAIN_INSTRUCTIONS,
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

// --- Shared connection logic ---

const connectVoiceSession$ = command(
  async ({ get, set }, sessionSignal: AbortSignal) => {
    const fetchFn = get(fetch$);

    set(internalStatus$, "connecting");

    const tokenRes = await fetchFn("/api/zero/voice-chat/token", {
      method: "POST",
    });
    sessionSignal.throwIfAborted();

    if (!tokenRes.ok) {
      const body = (await tokenRes.json()) as {
        error: { message: string };
      };
      sessionSignal.throwIfAborted();
      set(internalError$, body.error.message);
      set(internalStatus$, "error");
      return;
    }

    const { client_secret: clientSecret } = (await tokenRes.json()) as {
      client_secret: { value: string; expires_at: number };
    };
    sessionSignal.throwIfAborted();

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
    sessionSignal.throwIfAborted();
    set(internalStream$, stream);

    const ok = await set(
      setupWebRTC$,
      stream,
      clientSecret.value,
      sessionSignal,
    );
    sessionSignal.throwIfAborted();
    if (!ok) {
      return;
    }

    await Promise.allSettled([
      set(startHeartbeat$, sessionSignal),
      set(startPoll$, sessionSignal),
    ]);
  },
);

// --- Shared preparation → activate → connect flow ---

const prepareActivateConnect$ = command(
  async (
    { get, set },
    sessionId: string,
    sessionSignal: AbortSignal,
    signal: AbortSignal,
  ) => {
    const fetchFn = get(fetch$);

    // Start heartbeat during preparation to prevent session timeout
    const heartbeatPromise = set(startHeartbeat$, sessionSignal);

    // Poll for preparation-ready event
    await setLoop(
      async (loopSignal: AbortSignal) => {
        const sid = get(internalSessionId$);
        if (!sid) {
          return true;
        }

        const lastSeq = get(internalLastSeq$);
        const res = await fetchFn(
          `/api/zero/voice-chat/${sid}/context?after=${lastSeq}`,
          { signal: loopSignal },
        );

        if (!res.ok) {
          return false;
        }

        const data = (await res.json()) as { events: ContextEvent[] };
        loopSignal.throwIfAborted();

        if (data.events.length > 0) {
          set(internalEvents$, (prev) => {
            return [...prev, ...data.events];
          });
          const lastEvent = data.events[data.events.length - 1];
          if (lastEvent) {
            set(internalLastSeq$, lastEvent.seq);
          }

          if (
            data.events.some((e) => {
              return e.type === "preparation-ready";
            })
          ) {
            return true;
          }
        }
        return false;
      },
      POLL_INTERVAL_MS,
      sessionSignal,
    );
    signal.throwIfAborted();

    // Activate session (preparing → active)
    const activateRes = await fetchFn(
      `/api/zero/voice-chat/${sessionId}/activate`,
      { method: "POST" },
    );
    signal.throwIfAborted();

    if (!activateRes.ok) {
      set(internalError$, "Failed to activate session");
      set(internalStatus$, "error");
      return;
    }

    // Connect voice (token → mic → WebRTC → poll/heartbeat)
    await Promise.allSettled([
      heartbeatPromise,
      set(connectVoiceSession$, sessionSignal),
    ]);
  },
);

// --- Exported commands ---

export const startVoiceChat$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (
      get(internalStatus$) === "connecting" ||
      get(internalStatus$) === "connected" ||
      get(internalStatus$) === "preparing"
    ) {
      return;
    }

    set(internalStatus$, "preparing");
    set(internalError$, null);
    set(internalTranscript$, []);
    set(internalEvents$, []);
    set(internalMuted$, false);
    set(internalSessionId$, null);
    set(internalLastSeq$, 0);
    set(internalCurrentAssistant$, null);
    set(internalPrompt$, null);

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

    await set(prepareActivateConnect$, session.id, sessionSignal, signal);
  },
);

export const startVoiceMeeting$ = command(
  async ({ get, set }, prompt: string, signal: AbortSignal) => {
    if (
      get(internalStatus$) === "connecting" ||
      get(internalStatus$) === "connected" ||
      get(internalStatus$) === "preparing"
    ) {
      return;
    }

    set(internalStatus$, "preparing");
    set(internalError$, null);
    set(internalTranscript$, []);
    set(internalEvents$, []);
    set(internalMuted$, false);
    set(internalSessionId$, null);
    set(internalLastSeq$, 0);
    set(internalCurrentAssistant$, null);
    set(internalPrompt$, prompt);

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
      body: JSON.stringify({ agentId, mode: "meeting", prompt }),
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

    await set(prepareActivateConnect$, session.id, sessionSignal, signal);
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
  set(internalPrompt$, null);
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
