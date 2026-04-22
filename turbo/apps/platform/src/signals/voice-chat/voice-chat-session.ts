import { command, computed, state } from "ccstate";
import {
  FeatureSwitchKey,
  zeroVoiceChatSessionsContract,
  zeroVoiceChatContextContract,
  zeroVoiceChatTasksContract,
  type ContextEvent,
  type VoiceChatTask,
} from "@vm0/core";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { defaultAgentId$ } from "../agent.ts";
import { delay } from "signal-timers";
import { resetSignal, throwIfAbort, onDomEventFn, setLoop } from "../utils.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { zeroClient$ } from "../api-client.ts";
import { accept, ApiError } from "../../lib/accept.ts";

type ConnectionStatus =
  | "idle"
  | "preparing"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  id: string;
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
// 120s absorbs runner VM cold-start variance. Prep normally finishes in well
// under 30s; the buffer guards against occasional cold sandboxes without
// failing the UI too eagerly. Revisit (tighten) once cold-start p95 stabilises.
const PREP_TIMEOUT_CHAT_MS = 120_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;
export type RealtimeModel = "gpt-realtime" | "gpt-realtime-mini";

const HANDS_FREE_VAD_CONFIG = {
  type: "semantic_vad",
  eagerness: "medium",
} as const;

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

## Receiving task updates

You may also receive messages starting with [Task dispatched] or [Task completed: ...]. These are background tasks your slow-brain has kicked off on your behalf. Use them purely for situational awareness:

- If the user asks "what are you doing right now?" or similar, you can mention the subject naturally — "I'm looking up that PR for you" or "I was checking your calendar."
- Do NOT read the task message verbatim. Do NOT announce dispatch or completion unless slow-brain explicitly directs you to via a directive.
- Do NOT interrupt an ongoing utterance when you see these — they are background context, not commands.

Directives from slow-brain remain the authoritative source for what to say next. Task messages just help you stay grounded when the user asks what is happening.

## Communication style

- Keep responses concise and natural. You are speaking, not writing.
- Do not use markdown formatting, bullet points, or code blocks.
- Be warm and conversational, like a helpful colleague.
`.trim();

function formatInjectionMessage(event: ContextEvent): string {
  const prefixes: Record<string, string> = {
    directive: "[Slow-brain directive]",
    thinking: "[Slow-brain thinking]",
    observation: "[Slow-brain observation]",
  };
  const label = prefixes[event.type] ?? `[Slow-brain update - ${event.type}]`;
  return `${label} ${event.content ?? ""}`.trim();
}

const SYSTEM_TASK_INJECTION_MAX = 400;

function truncateForInjection(s: string | null | undefined): string {
  if (!s) {
    return "";
  }
  return s.length > SYSTEM_TASK_INJECTION_MAX
    ? `${s.slice(0, SYSTEM_TASK_INJECTION_MAX)}…`
    : s;
}

function formatSystemTaskMessage(event: ContextEvent): string | null {
  if (!event.content) {
    return null;
  }
  let parsed: unknown;
  // eslint-disable-next-line no-restricted-syntax -- defensive parse: content is backend JSON, drop silently on malformed input rather than crashing the realtime loop
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const p = parsed as Record<string, unknown>;

  if (event.type === "task-dispatched") {
    const prompt = typeof p.prompt === "string" ? p.prompt : "";
    const body = truncateForInjection(prompt);
    return body ? `[Task dispatched] ${body}` : "[Task dispatched]";
  }
  if (event.type === "task-completed") {
    const status = typeof p.status === "string" ? p.status : "done";
    const result = typeof p.result === "string" ? p.result : "";
    const error = typeof p.error === "string" ? p.error : "";
    const body = truncateForInjection(status === "failed" ? error : result);
    const label = `[Task completed: ${status}]`;
    return body ? `${label} ${body}` : label;
  }
  return null;
}

// --- Internal state ---

const internalStatus$ = state<ConnectionStatus>("idle");
const internalTranscript$ = state<TranscriptEntry[]>([]);
const internalEvents$ = state<ContextEvent[]>([]);
const internalTasksById$ = state<Record<string, VoiceChatTask>>({});
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
const internalPrepStartTime$ = state<number | null>(null);
const internalPrepElapsedMs$ = state(0);
const internalReconnectAttempt$ = state(0);
const internalModel$ = state<RealtimeModel>("gpt-realtime-mini");

const internalWakeLock$ = state<WakeLockSentinel | null>(null);

const resetSessionSignal$ = resetSignal();

// --- Exported computed ---

export const vcStatus$ = computed((get) => {
  return get(internalStatus$);
});
export const vcTranscript$ = computed((get) => {
  return get(internalTranscript$);
});
type ConversationItem =
  | { kind: "transcript"; entry: TranscriptEntry; order: number; key: string }
  | { kind: "slow-brain"; event: ContextEvent; order: number; key: string };

export const vcConversationItems$ = (() => {
  const orderMap = new Map<string, number>();
  let counter = 0;

  function assignOrder(key: string): number {
    let order = orderMap.get(key);
    if (order === undefined) {
      order = counter++;
      orderMap.set(key, order);
    }
    return order;
  }

  return computed((get) => {
    const transcript = get(internalTranscript$);
    const slowBrain = get(internalEvents$).filter((e) => {
      return e.source === "slow-brain";
    });

    if (transcript.length === 0 && slowBrain.length === 0) {
      orderMap.clear();
      counter = 0;
      return [] as ConversationItem[];
    }

    const items: ConversationItem[] = [];

    for (const entry of transcript) {
      const key = entry.id;
      items.push({ kind: "transcript", entry, order: assignOrder(key), key });
    }

    for (const event of slowBrain) {
      const key = `sb-${event.seq}`;
      items.push({ kind: "slow-brain", event, order: assignOrder(key), key });
    }

    items.sort((a, b) => {
      return a.order - b.order;
    });

    return items;
  });
})();

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
  return await get(defaultAgentId$);
});
export const vcPrepElapsedMs$ = computed((get) => {
  return get(internalPrepElapsedMs$);
});
export const vcReconnectAttempt$ = computed((get) => {
  return get(internalReconnectAttempt$);
});
export const vcModel$ = computed((get) => {
  return get(internalModel$);
});
export const setVcModel$ = command(({ set }, model: RealtimeModel) => {
  set(internalModel$, model);
});

export const vcTasksById$ = computed((get) => {
  return get(internalTasksById$);
});

export const vcActiveTasks$ = computed((get) => {
  return Object.values(get(internalTasksById$))
    .filter((t) => {
      return t.status === "queued" || t.status === "running";
    })
    .sort((a, b) => {
      return b.createdAt.localeCompare(a.createdAt);
    });
});

export const vcAllTasksSorted$ = computed((get) => {
  return Object.values(get(internalTasksById$)).sort((a, b) => {
    return b.createdAt.localeCompare(a.createdAt);
  });
});

// --- Internal commands ---

const logContextEvent$ = command(
  (
    { get },
    sessionId: string | null,
    source: string,
    type: string,
    content: string,
  ) => {
    if (!sessionId) {
      return;
    }
    const createClient = get(zeroClient$);
    const client = createClient(zeroVoiceChatContextContract);
    accept(
      client.appendEvent({
        params: { id: sessionId },
        body: { source, type, content },
      }),
      [200],
      { toast: false },
    ).catch(() => {
      return undefined;
    });
  },
);

const handleFnCall$ = command(
  (
    { get, set },
    callId: string,
    name: string,
    args: string,
    signal: AbortSignal,
  ) => {
    const sid = get(internalSessionId$);
    if (!sid) {
      return;
    }
    signal.throwIfAborted();

    let result: string;

    if (name === "request_slow_brain") {
      const parsed = JSON.parse(args) as { task: string };
      set(
        logContextEvent$,
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
          set(
            logContextEvent$,
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
          set(
            logContextEvent$,
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
    // Historical name kept — this command also injects system/task-dispatched
    // and system/task-completed events as non-interrupting situational
    // awareness for fast-brain. `needsResponse` stays tied to slow-brain
    // directive/observation only, so task events never fire response.cancel.
    const dc = get(internalDc$);
    if (!dc || dc.readyState !== "open") {
      return;
    }

    const slowBrainEvents = events.filter((e) => {
      return e.source === "slow-brain" && e.content;
    });
    const systemTaskEvents = events.filter((e) => {
      return (
        e.source === "system" &&
        (e.type === "task-dispatched" || e.type === "task-completed")
      );
    });
    if (slowBrainEvents.length === 0 && systemTaskEvents.length === 0) {
      return;
    }

    const needsResponse = slowBrainEvents.some((e) => {
      return e.type === "directive" || e.type === "observation";
    });

    // Interrupt if model is mid-speech and we need a response
    const current = get(internalCurrentAssistant$);
    if (current && needsResponse) {
      dc.send(JSON.stringify({ type: "response.cancel" }));
      set(internalCurrentAssistant$, null);
    }

    // Inject each event as a user message (all types, for context)
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

    // Inject task-dispatched / task-completed as non-interrupting context
    for (const event of systemTaskEvents) {
      const text = formatSystemTaskMessage(event);
      if (!text) {
        continue;
      }
      dc.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        }),
      );
    }

    // Only trigger response for actionable events
    if (needsResponse) {
      dc.send(JSON.stringify({ type: "response.create" }));
    }
  },
);

interface WebRTCConfig {
  token: string;
  model: RealtimeModel;
}

const setupWebRTC$ = command(
  async (
    { get, set },
    stream: MediaStream,
    config: WebRTCConfig,
    parentSignal: AbortSignal,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { token, model } = config;
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
            input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
            input_audio_noise_reduction: { type: "far_field" },
            turn_detection: HANDS_FREE_VAD_CONFIG,
            tools: SESSION_TOOLS,
          },
        }),
      );
      set(internalStatus$, "connected");

      // Inject slow-brain events collected during preparation phase
      const prepEvents = get(internalEvents$);
      if (prepEvents.length > 0) {
        set(injectSlowBrainEvents$, prepEvents);
      }
    });

    dc.addEventListener(
      "message",
      onDomEventFn((ev: MessageEvent) => {
        return set(handleDCMessage$, ev.data as string, signal);
      }),
    );

    dc.addEventListener(
      "close",
      onDomEventFn((): void | Promise<void> => {
        if (get(internalStatus$) === "connected") {
          return set(reconnectVoiceSession$, signal, parentSignal);
        }
      }),
    );

    pc.addEventListener(
      "iceconnectionstatechange",
      onDomEventFn((): void | Promise<void> => {
        if (
          pc.iceConnectionState === "failed" ||
          pc.iceConnectionState === "disconnected"
        ) {
          if (get(internalStatus$) === "connected") {
            return set(reconnectVoiceSession$, signal, parentSignal);
          }
        }
      }),
    );

    const offer = await pc.createOffer();
    signal.throwIfAborted();
    await pc.setLocalDescription(offer);
    signal.throwIfAborted();

    const sdpRes = await globalThis.fetch(
      `https://api.openai.com/v1/realtime?model=${model}`,
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
    async () => {
      const sid = get(internalSessionId$);
      if (!sid) {
        return true;
      }

      const createClient = get(zeroClient$);
      const client = createClient(zeroVoiceChatSessionsContract);
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

const POLL_FAILURE_THRESHOLD = 3;

const startPoll$ = command(async ({ get, set }, signal: AbortSignal) => {
  let consecutiveFailures = 0;
  const sid = get(internalSessionId$);
  if (!sid) {
    throw new Error("startPoll$ called before session ID is set");
  }

  const pollBody$ = command(async ({ get, set }, loopSignal: AbortSignal) => {
    const innerSid = get(internalSessionId$);
    if (!innerSid) {
      return true;
    }

    const lastSeq = get(internalLastSeq$);
    const createClient = get(zeroClient$);
    const client = createClient(zeroVoiceChatContextContract);

    let res: Awaited<ReturnType<typeof client.getEvents>> & { status: 200 };
    // eslint-disable-next-line no-restricted-syntax -- observe ApiError to track threshold UI before rethrowing so setLoop applies backoff
    try {
      res = await accept(
        client.getEvents({
          params: { id: innerSid },
          query: { after: lastSeq },
        }),
        [200],
        { toast: false },
      );
    } catch (error) {
      throwIfAbort(error);
      if (error instanceof ApiError) {
        consecutiveFailures++;
        if (consecutiveFailures >= POLL_FAILURE_THRESHOLD) {
          set(internalError$, "Connection issues — retrying…");
        }
      }
      throw error;
    }
    loopSignal.throwIfAborted();

    if (consecutiveFailures >= POLL_FAILURE_THRESHOLD) {
      set(internalError$, null);
    }
    consecutiveFailures = 0;

    if (res.body.events.length > 0) {
      set(internalEvents$, (prev) => {
        return [...prev, ...res.body.events];
      });
      const lastEvent = res.body.events[res.body.events.length - 1];
      if (lastEvent) {
        set(internalLastSeq$, lastEvent.seq);
      }
      set(injectSlowBrainEvents$, res.body.events);
    }

    const tasksClient = createClient(zeroVoiceChatTasksContract);
    const tasksRes = await accept(
      tasksClient.listTasks({ params: { id: innerSid } }),
      [200, 401, 404],
      { toast: false },
    );
    loopSignal.throwIfAborted();
    if (tasksRes.status === 200) {
      const next: Record<string, VoiceChatTask> = {};
      for (const task of tasksRes.body.tasks) {
        next[task.id] = task;
      }
      set(internalTasksById$, next);
    }

    return false;
  });

  await set(setAblyLoop$, `voice:${sid}`, pollBody$, signal);
});

// --- WebRTC cleanup (preserves session state) ---

const cleanupWebRTC$ = command(({ get, set }) => {
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

  const audioEl = get(internalAudioEl$);
  if (audioEl) {
    audioEl.pause();
    audioEl.srcObject = null;
    set(internalAudioEl$, null);
  }
});

// --- Reconnect logic ---

const reconnectVoiceSession$ = command(
  async ({ get, set }, signal: AbortSignal, parentSignal: AbortSignal) => {
    set(internalStatus$, "reconnecting");
    set(internalError$, null);
    set(internalReconnectAttempt$, 0);

    const sid = get(internalSessionId$);
    if (!sid) {
      set(internalError$, "No session to reconnect");
      set(internalStatus$, "error");
      return;
    }

    const createClient = get(zeroClient$);
    const client = createClient(zeroVoiceChatSessionsContract);

    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      signal.throwIfAborted();
      set(internalReconnectAttempt$, attempt);

      // Exponential backoff delay (skip on first attempt)
      if (attempt > 1) {
        const backoff = Math.min(
          RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 2),
          30_000,
        );
        await delay(backoff, { signal });
      }

      // Check if session is still alive via heartbeat
      const heartbeatRes = await accept(
        client.heartbeat({ params: { id: sid }, body: {} }),
        [200, 401, 404],
        { toast: false },
      );
      signal.throwIfAborted();
      if (heartbeatRes.status !== 200) {
        set(internalError$, "Session is no longer active");
        set(internalStatus$, "error");
        return;
      }

      // Clean up old WebRTC resources
      set(cleanupWebRTC$);

      // Fetch new token with selected model
      const model = get(internalModel$);
      const tokenRes = await accept(
        client.token({ body: { model } }),
        [200, 401, 403, 500, 503],
        { toast: false },
      );
      signal.throwIfAborted();
      if (tokenRes.status === 401 || tokenRes.status === 403) {
        set(
          internalError$,
          tokenRes.body.error.message || "Authentication failed",
        );
        set(internalStatus$, "error");
        return;
      }
      if (tokenRes.status !== 200) {
        // Transient failure — retry
        continue;
      }

      const { client_secret: clientSecret } = tokenRes.body;
      signal.throwIfAborted();

      // Check if existing mic stream is still active
      let stream = get(internalStream$);
      if (
        !stream ||
        stream.getAudioTracks().every((t) => {
          return !t.enabled || t.readyState === "ended";
        })
      ) {
        // eslint-disable-next-line no-restricted-syntax -- getUserMedia can fail due to permission denial
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
          set(internalStream$, stream);
        } catch (error) {
          throwIfAbort(error);
          set(internalError$, "Microphone access denied");
          set(internalStatus$, "error");
          return;
        }
      }
      signal.throwIfAborted();

      // Setup new WebRTC connection
      const ok = await set(
        setupWebRTC$,
        stream,
        { token: clientSecret.value, model },
        parentSignal,
        signal,
      );
      if (ok) {
        // Success — restart heartbeat and poll loops
        set(internalReconnectAttempt$, 0);
        await set(acquireWakeLock$, signal);
        signal.throwIfAborted();
        const sessionSignal = set(resetSessionSignal$, parentSignal);
        await Promise.allSettled([
          set(startHeartbeat$, sessionSignal),
          set(startPoll$, sessionSignal),
        ]);
        signal.throwIfAborted();
        return;
      }

      // setupWebRTC$ failed — will retry on next iteration
    }

    // Max retries exhausted
    set(internalReconnectAttempt$, 0);
    set(internalStatus$, "disconnected");
  },
);

// --- Wake lock ---

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
    // eslint-disable-next-line no-restricted-syntax -- wakeLock.request can fail if document is not visible
    try {
      lock = await navigator.wakeLock.request("screen");
    } catch {
      // Wake lock request failed — non-critical, ignore
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
    // Re-acquire when the browser releases the lock (e.g. tab becomes hidden)
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

  // Re-acquire when the page becomes visible again after being hidden
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "visible" && !signal.aborted) {
      // Reset reacquire count on visibility change — this is user-initiated
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

// --- Shared connection logic ---

const connectVoiceSession$ = command(
  async (
    { get, set },
    sessionSignal: AbortSignal,
    parentSignal: AbortSignal,
  ) => {
    const model = get(internalModel$);

    set(internalStatus$, "connecting");

    const createClient = get(zeroClient$);
    const sessionsClient = createClient(zeroVoiceChatSessionsContract);
    const tokenRes = await accept(
      sessionsClient.token({ body: { model } }),
      [200, 401, 403, 500, 503],
      { toast: false },
    );
    sessionSignal.throwIfAborted();

    if (tokenRes.status !== 200) {
      set(internalError$, tokenRes.body.error.message);
      set(internalStatus$, "error");
      return;
    }

    const { client_secret: clientSecret } = tokenRes.body;
    sessionSignal.throwIfAborted();

    let stream: MediaStream;
    // eslint-disable-next-line no-restricted-syntax -- getUserMedia can fail due to permission denial or missing hardware
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
    sessionSignal.throwIfAborted();
    set(internalStream$, stream);

    const ok = await set(
      setupWebRTC$,
      stream,
      { token: clientSecret.value, model },
      parentSignal,
      sessionSignal,
    );
    sessionSignal.throwIfAborted();
    if (!ok) {
      return;
    }

    await set(acquireWakeLock$, sessionSignal);
    sessionSignal.throwIfAborted();

    await Promise.allSettled([
      set(startHeartbeat$, sessionSignal),
      set(startPoll$, sessionSignal),
    ]);
  },
);

// --- Shared preparation → activate → connect flow ---

interface PrepareActivateConfig {
  sessionId: string;
  timeoutMs: number;
}

const prepareActivateConnect$ = command(
  async (
    { get, set },
    config: PrepareActivateConfig,
    sessionSignal: AbortSignal,
    parentSignal: AbortSignal,
    signal: AbortSignal,
  ) => {
    const { sessionId, timeoutMs } = config;
    const startTime = Date.now();
    let preparationReady = false;

    // Start heartbeat during preparation to prevent session timeout
    const heartbeatPromise = set(startHeartbeat$, sessionSignal);

    // Poll for preparation-ready event with timeout
    const prepPollBody$ = command(
      async ({ get, set }, loopSignal: AbortSignal) => {
        const elapsed = Date.now() - startTime;
        set(internalPrepElapsedMs$, elapsed);

        if (elapsed > timeoutMs) {
          return true;
        }

        const sid = get(internalSessionId$);
        if (!sid) {
          return true;
        }

        const lastSeq = get(internalLastSeq$);
        const createClient = get(zeroClient$);
        const contextClient = createClient(zeroVoiceChatContextContract);
        const res = await accept(
          contextClient.getEvents({
            params: { id: sid },
            query: { after: lastSeq },
          }),
          [200],
          { toast: false },
        );
        loopSignal.throwIfAborted();

        if (res.body.events.length > 0) {
          set(internalEvents$, (prev) => {
            return [...prev, ...res.body.events];
          });
          const lastEvent = res.body.events[res.body.events.length - 1];
          if (lastEvent) {
            set(internalLastSeq$, lastEvent.seq);
          }

          if (
            res.body.events.some((e) => {
              return e.type === "preparation-ready";
            })
          ) {
            preparationReady = true;
            return true;
          }
        }
        return false;
      },
    );
    await set(setAblyLoop$, `voice:${sessionId}`, prepPollBody$, sessionSignal);
    signal.throwIfAborted();

    if (!preparationReady) {
      if (!sessionSignal.aborted) {
        set(internalPrepStartTime$, null);
        set(internalPrepElapsedMs$, 0);
        set(internalError$, "Preparation timed out");
        set(internalStatus$, "error");
        const sid = get(internalSessionId$);
        if (sid) {
          const createClient = get(zeroClient$);
          const sessionsClient = createClient(zeroVoiceChatSessionsContract);
          accept(
            sessionsClient.end({ params: { id: sid }, body: {} }),
            [200, 401, 404],
            { toast: false },
          ).catch(() => {
            return undefined;
          });
        }
      }
      return;
    }

    signal.throwIfAborted();

    // Activate session (preparing → active)
    const createClient = get(zeroClient$);
    const sessionsClient = createClient(zeroVoiceChatSessionsContract);
    const activateRes = await accept(
      sessionsClient.activate({ params: { id: sessionId }, body: {} }),
      [200, 401, 404],
      { toast: false },
    );
    signal.throwIfAborted();

    if (activateRes.status !== 200) {
      set(internalError$, "Failed to activate session");
      set(internalStatus$, "error");
      return;
    }

    // Connect voice (token → mic → WebRTC → poll/heartbeat)
    await Promise.allSettled([
      heartbeatPromise,
      set(connectVoiceSession$, sessionSignal, parentSignal),
    ]);
  },
);

// --- Exported commands ---

export const startVoiceChat$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (
      get(internalStatus$) === "connecting" ||
      get(internalStatus$) === "connected" ||
      get(internalStatus$) === "preparing" ||
      get(internalStatus$) === "reconnecting"
    ) {
      return;
    }

    set(internalStatus$, "preparing");
    set(internalError$, null);
    set(internalTranscript$, []);
    set(internalEvents$, []);
    set(internalTasksById$, {});
    set(internalMuted$, false);
    set(internalSessionId$, null);
    set(internalLastSeq$, 0);
    set(internalCurrentAssistant$, null);
    set(internalPrepStartTime$, Date.now());

    const sessionSignal = set(resetSessionSignal$, signal);

    // eslint-disable-next-line no-restricted-syntax -- safety net: any non-abort rejection after setting "preparing" must transition to "error" or VoiceBanner sticks on "Enabling…"
    try {
      const agentId = await get(defaultAgentId$);
      signal.throwIfAborted();

      if (!agentId) {
        set(internalError$, "No agent selected");
        set(internalStatus$, "error");
        return;
      }

      const createClient = get(zeroClient$);
      const sessionsClient = createClient(zeroVoiceChatSessionsContract);
      const sessionRes = await accept(
        sessionsClient.create({ body: { agentId } }),
        [200, 400, 401, 403],
        { toast: false },
      );
      signal.throwIfAborted();

      if (sessionRes.status !== 200) {
        set(internalError$, sessionRes.body.error.message);
        set(internalStatus$, "error");
        return;
      }

      const { session } = sessionRes.body;
      set(internalSessionId$, session.id);

      await set(
        prepareActivateConnect$,
        { sessionId: session.id, timeoutMs: PREP_TIMEOUT_CHAT_MS },
        sessionSignal,
        signal,
        signal,
      );
    } catch (error) {
      throwIfAbort(error);
      set(
        internalError$,
        error instanceof Error ? error.message : "Failed to start voice chat",
      );
      set(internalStatus$, "error");
    }
  },
);

export const endVoiceChat$ = command(({ get, set }) => {
  const sid = get(internalSessionId$);

  // End session on server so it's no longer "active" in DB
  if (sid) {
    const createClient = get(zeroClient$);
    const sessionsClient = createClient(zeroVoiceChatSessionsContract);
    accept(
      sessionsClient.end({ params: { id: sid }, body: {} }),
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
  set(internalTasksById$, {});
  set(internalPrepStartTime$, null);
  set(internalPrepElapsedMs$, 0);
  set(internalReconnectAttempt$, 0);
  set(internalModel$, "gpt-realtime-mini");
  set(internalStatus$, "idle");
});

export const retryVoiceChat$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const status = get(internalStatus$);
    if (status !== "disconnected") {
      return;
    }
    await set(reconnectVoiceSession$, signal, signal);
  },
);

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
