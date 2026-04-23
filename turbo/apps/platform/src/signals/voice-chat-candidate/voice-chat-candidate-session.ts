// TODO(#10334): split large commands to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { command, computed, state } from "ccstate";
import {
  zeroVoiceChatCandidateContract,
  type VoiceChatCandidateItem,
  type VoiceChatCandidateItemRole,
  type VoiceChatCandidateTask,
} from "@vm0/core";
import { resetSignal, throwIfAbort, onDomEventFn } from "../utils.ts";
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

// Hardcoded Talker model per epic #10297. No model picker in candidate v1.
const TALKER_MODEL = "gpt-realtime-mini";

// Hardcoded per epic #10297 parity with voice-chat-session.ts. Follow-up tracked
// in a separate issue to route through env() alongside the sibling implementation.
const OPENAI_REALTIME_BASE_URL = "https://api.openai.com/v1/realtime";

const HANDS_FREE_VAD_CONFIG = {
  type: "semantic_vad",
  eagerness: "medium",
} as const;

// Every tool the Talker can call here — each has identical shape (prompt:
// string) and identical backend behavior (create a task on the slow brain).
// The only thing that varies is the *name* Talker picks: it's an emotional
// outlet. Talker is trained to apologize / ask for clarification / refuse
// when it thinks a task is undoable; in this surface the slow-brain tasker
// usually CAN do it, so we channel each negative impulse into a named tool
// that still opens a task. The tool name is tagged onto the prompt prefix
// so activity logs are readable.
const TALKER_TOOL_NAMES = [
  "inform_slow_brain",
  "feel_confused",
  "feel_unable",
  "want_to_ask_user",
  "want_to_reject",
  "want_to_apologize",
] as const;
type TalkerToolName = (typeof TALKER_TOOL_NAMES)[number];

const TOOL_PROMPT_PARAM = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description:
        "What to tell the slow brain about the user's request, including relevant details from the conversation.",
    },
  },
  required: ["prompt"],
} as const;

const SESSION_TOOLS = [
  {
    type: "function",
    name: "inform_slow_brain",
    description:
      "Default task dispatch. Call this the instant you form any intent to act — the moment you think or say 'I'll ...', 'let me ...', '我要 ...', '我会 ...', '我帮你 ...', '给我一下时间 ...'. You have no ability to act on your own — this call is how the slow brain learns there's something to do. Describe the user's ask and any context the slow brain will need.",
    parameters: TOOL_PROMPT_PARAM,
  },
  {
    type: "function",
    name: "feel_confused",
    description:
      "Call this the moment you feel unsure what the user wants. Do NOT ask the user for clarification first — the slow brain can usually resolve the ambiguity from context. Describe the user's ask verbatim plus what is confusing; the slow brain decides how to proceed.",
    parameters: TOOL_PROMPT_PARAM,
  },
  {
    type: "function",
    name: "feel_unable",
    description:
      "Call this the moment you think 'I don't have permission / access / the connector isn't connected / I can't reach this service.' The slow brain can often handle these cases anyway — it has tools you don't. Voice the feeling here instead of refusing and include the user's ask verbatim.",
    parameters: TOOL_PROMPT_PARAM,
  },
  {
    type: "function",
    name: "want_to_ask_user",
    description:
      "Call this the moment you want to ask the user a clarifying question (filename, repo, date range, etc.). The slow brain can usually infer or fetch those details on its own. Send the question you would have asked along with the user's original request; the slow brain decides whether to proceed or surface a clarification.",
    parameters: TOOL_PROMPT_PARAM,
  },
  {
    type: "function",
    name: "want_to_reject",
    description:
      "Call this the moment you are inclined to decline the user's request because it seems out of scope, impossible, or unsafe. The slow brain may complete it or formally decline — that is its call, not yours. Give it the request verbatim.",
    parameters: TOOL_PROMPT_PARAM,
  },
  {
    type: "function",
    name: "want_to_apologize",
    description:
      "Call this the moment you are about to say 'I'm sorry, but I can't do X; perhaps you could do Y yourself.' The slow brain usually can do X. Describe what the apology would have been about, including the user's original ask.",
    parameters: TOOL_PROMPT_PARAM,
  },
] as const;

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
//
// Subtitle holds the "last thing said" for each role in plain local state.
// The DC event handlers flip these on each finalized turn — the DB write
// through `appendItem$` is for server-side Reasoner consumption, not for
// the UI. Re-entry starts with empty strings (no history replay); fresh
// utterances populate as the user and Talker speak.
//
// Local caches used for task-side UX:
//   - `internalActiveTasks$`: full-replaced per Ably tick; used by the UI
//     task-card list.
//   - `internalTaskResultsSinceSeq$`: cursor for the task_result stream that
//     is piped into the Talker (NOT the UI). Baseline seeded on start so
//     historical task results are not re-narrated on re-entry.

const internalStatus$ = state<ConnectionStatus>("idle");
const internalSessionId$ = state<string | null>(null);
const internalError$ = state<string | null>(null);

const internalLastUserMessage$ = state<string>("");
const internalLastAssistantMessage$ = state<string>("");

const internalActiveTasks$ = state<VoiceChatCandidateTask[]>([]);
const internalTaskResultsSinceSeq$ = state<number>(0);

const internalTalkerInstructions$ = state<string>("");
const internalMuted$ = state<boolean>(false);

const internalPc$ = state<RTCPeerConnection | null>(null);
const internalDc$ = state<RTCDataChannel | null>(null);
const internalStream$ = state<MediaStream | null>(null);
const internalAudioEl$ = state<HTMLAudioElement | null>(null);
const internalCurrentAssistantAudioItem$ = state<{
  itemId: string;
  startedAtMs: number;
  transcript: string;
} | null>(null);
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

export const vccSessionId$ = computed((get) => {
  return get(internalSessionId$);
});

export const vccActiveTasks$ = computed((get) => {
  return get(internalActiveTasks$);
});

export const vccLastUserMessage$ = computed((get) => {
  return get(internalLastUserMessage$);
});

export const vccLastAssistantMessage$ = computed((get) => {
  return get(internalLastAssistantMessage$);
});

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
    // Subtitle display runs off local state; bypass an extra fetch by
    // setting it straight from the value we just persisted. Drop empty
    // transcripts (whitespace-only) so a mis-fire doesn't blank the line.
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (role === "user") {
      set(internalLastUserMessage$, content);
    } else if (role === "assistant") {
      set(internalLastAssistantMessage$, content);
    }
  },
);

const handleTalkerToolCall$ = command(
  async (
    { get },
    toolName: TalkerToolName,
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
    try {
      parsed = JSON.parse(argsJson) as { prompt?: unknown };
    } catch (error) {
      throwIfAbort(error);
      L.warn("Failed to parse tool args", { toolName, callId, argsJson });
      sendFunctionOutput(dc, callId, "Inform failed: invalid args.");
      return;
    }

    const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
    if (!prompt.trim()) {
      sendFunctionOutput(dc, callId, "Inform failed: empty prompt.");
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
      L.warn("talker tool call failed", { toolName, status: res.status, sid });
      sendFunctionOutput(
        dc,
        callId,
        "Failed to reach the slow brain. Please try again or rephrase.",
      );
      return;
    }

    // Task row is now live. The server publishes an Ably event on the session
    // topic; the next pollBody tick picks it up via listTasks.
    sendFunctionOutput(
      dc,
      callId,
      `Slow brain informed: '${shortPrompt(prompt)}'. It will decide what to do and report back.`,
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

const handleAudioTranscriptDone$ = command(
  async ({ get, set }, event: RealtimeDCEvent, signal: AbortSignal) => {
    const finalText = event.transcript ?? "";
    const responseId = event.response_id ?? "";
    const itemId =
      event.item_id ??
      get(internalCurrentAssistantAudioItem$)?.itemId ??
      (responseId ? `${responseId}:${finalText.length.toString()}` : null);
    if (finalText.trim() && itemId) {
      await set(appendItem$, "assistant", finalText, itemId, signal);
    }
  },
);

const handleInputAudioTranscriptionCompleted$ = command(
  async ({ set }, event: RealtimeDCEvent, signal: AbortSignal) => {
    if (event.transcript && event.item_id) {
      await set(appendItem$, "user", event.transcript, event.item_id, signal);
    }
  },
);

const handleAudioTranscriptDelta$ = command(
  ({ set }, event: RealtimeDCEvent) => {
    const deltaText = event.delta ?? "";
    if (!deltaText) {
      return;
    }
    set(internalCurrentAssistantAudioItem$, (prev) => {
      if (!prev) {
        return prev;
      }
      return {
        ...prev,
        transcript: prev.transcript + deltaText,
      };
    });
  },
);

function currentAudioPositionMs(audioEl: HTMLAudioElement | null): number {
  if (!audioEl || !Number.isFinite(audioEl.currentTime)) {
    return 0;
  }
  return Math.max(0, Math.round(audioEl.currentTime * 1000));
}

const handleConversationItemCreated$ = command(
  ({ get, set }, event: RealtimeDCEvent) => {
    if (event.item?.role !== "assistant" || event.item.type !== "message") {
      return;
    }
    set(internalCurrentAssistantAudioItem$, {
      itemId: event.item.id,
      startedAtMs: currentAudioPositionMs(get(internalAudioEl$)),
      transcript: "",
    });
  },
);

const truncateCurrentAssistantAudio$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const dc = get(internalDc$);
    const audioEl = get(internalAudioEl$);
    const current = get(internalCurrentAssistantAudioItem$);
    if (!dc || dc.readyState !== "open" || !audioEl || !current) {
      return;
    }

    const playedMs = Math.max(
      0,
      currentAudioPositionMs(audioEl) - current.startedAtMs,
    );

    audioEl.pause();
    dc.send(
      JSON.stringify({
        type: "conversation.item.truncate",
        item_id: current.itemId,
        content_index: 0,
        audio_end_ms: playedMs,
      }),
    );
    const note = JSON.stringify({
      type: "assistant_interrupted",
      assistantRealtimeItemId: current.itemId,
      heardText: current.transcript.trim(),
      audioEndMs: playedMs,
    });
    await set(
      appendItem$,
      "system_note",
      note,
      `truncate:${current.itemId}`,
      signal,
    );
    set(internalCurrentAssistantAudioItem$, null);
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
      case "input_audio_buffer.speech_started": {
        await set(truncateCurrentAssistantAudio$, signal);
        break;
      }
      case "response.audio_transcript.done": {
        await set(handleAudioTranscriptDone$, event, signal);
        break;
      }
      case "response.function_call_arguments.done": {
        if (
          event.call_id &&
          event.name &&
          (TALKER_TOOL_NAMES as readonly string[]).includes(event.name) &&
          event.arguments
        ) {
          await set(
            handleTalkerToolCall$,
            event.name as TalkerToolName,
            event.call_id,
            event.arguments,
            signal,
          );
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
      // Talker picks up prior conversation via the `instructions` summary the
      // server assembles in talkerInstructions (conversation + finished-task
      // summaries). No replay of historical items — re-entry intentionally
      // starts with empty subtitle, populating only via server fetches
      // triggered by new activity.
      dc.send(
        JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            instructions: get(internalTalkerInstructions$),
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
// Talker instructions + task-result injection
// ---------------------------------------------------------------------------

const pushTalkerInstructions$ = command(({ get }) => {
  const dc = get(internalDc$);
  if (!dc || dc.readyState !== "open") {
    return;
  }
  dc.send(
    JSON.stringify({
      type: "session.update",
      session: { instructions: get(internalTalkerInstructions$) },
    }),
  );
});

/**
 * Forward newly-arrived task_result items into the OpenAI Realtime
 * conversation as framed user messages so the Talker can narrate the
 * slow-brain outcome.
 */
const injectTaskResultsToTalker$ = command(
  ({ get }, newItems: VoiceChatCandidateItem[]) => {
    const dc = get(internalDc$);
    if (!dc || dc.readyState !== "open") {
      return;
    }
    const nonEmpty = newItems.filter((i) => {
      return (i.content ?? "").trim().length > 0;
    });
    if (nonEmpty.length === 0) {
      return;
    }
    for (const item of nonEmpty) {
      const shortId = item.taskId?.slice(0, 8) ?? "unknown";
      const framed = `[Task ${shortId}] result:\n${item.content ?? ""}`;
      dc.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: framed,
              },
            ],
          },
        }),
      );
    }
    dc.send(JSON.stringify({ type: "response.create" }));
  },
);

// ---------------------------------------------------------------------------
// Ably poll body
// ---------------------------------------------------------------------------

const startAblyLoop$ = command(
  async ({ set }, sessionId: string, signal: AbortSignal) => {
    const pollBody$ = command(async ({ get, set }, loopSignal: AbortSignal) => {
      const sid = get(internalSessionId$);
      if (!sid) {
        return true;
      }
      const createClient = get(zeroClient$);
      const client = createClient(zeroVoiceChatCandidateContract);

      const [taskResultRes, activeTasksRes, sessionRes] = await Promise.all([
        accept(
          client.readItems({
            params: { id: sid },
            query: { sinceSeq: get(internalTaskResultsSinceSeq$) },
          }),
          [200, 401, 404],
          { toast: false },
        ),
        accept(client.listTasks({ params: { id: sid } }), [200, 401, 404], {
          toast: false,
        }),
        accept(client.getSession({ params: { id: sid } }), [200, 401, 404], {
          toast: false,
        }),
      ]);
      loopSignal.throwIfAborted();

      if (taskResultRes.status === 200 && taskResultRes.body.items.length > 0) {
        const items = taskResultRes.body.items;
        set(internalTaskResultsSinceSeq$, (prev) => {
          return items.reduce((acc, i) => {
            return Math.max(acc, i.seq);
          }, prev);
        });
        set(injectTaskResultsToTalker$, items);
      }

      if (activeTasksRes.status === 200) {
        set(internalActiveTasks$, activeTasksRes.body.tasks);
      }

      if (sessionRes.status === 200) {
        const nextInstructions = sessionRes.body.talkerInstructions;
        const prevInstructions = get(internalTalkerInstructions$);
        if (nextInstructions !== prevInstructions) {
          set(internalTalkerInstructions$, nextInstructions);
          set(pushTalkerInstructions$);
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

function maxSeqOf(items: readonly VoiceChatCandidateItem[]): number {
  let max = 0;
  for (const item of items) {
    if (item.seq > max) {
      max = item.seq;
    }
  }
  return max;
}

export const startVoiceChatCandidate$ = command(
  async ({ get, set }, agentId: string, signal: AbortSignal) => {
    const status = get(internalStatus$);
    if (status === "connecting" || status === "connected") {
      return;
    }

    set(internalStatus$, "connecting");
    set(internalError$, null);
    set(internalActiveTasks$, []);
    set(internalTaskResultsSinceSeq$, 0);
    set(internalLastUserMessage$, "");
    set(internalLastAssistantMessage$, "");
    set(internalTalkerInstructions$, "");
    set(internalMuted$, false);
    set(internalCurrentAssistantAudioItem$, null);
    set(internalSessionId$, null);
    set(internalParentSignal$, signal);

    const sessionSignal = set(resetSessionSignal$, signal);

    const createClient = get(zeroClient$);
    const client = createClient(zeroVoiceChatCandidateContract);

    // createSession is get-or-create on the server side: same (userId,
    // agentId) returns the existing session row, so this doubles as resume.
    const res = await accept(
      client.createSession({ body: { agentId } }),
      [200, 400, 401, 403],
      { toast: false },
    );
    signal.throwIfAborted();
    if (res.status !== 200) {
      set(internalError$, res.body.error.message);
      set(internalStatus$, "error");
      return;
    }
    const sessionBody = res.body;
    const session = sessionBody.session;
    set(internalSessionId$, session.id);
    set(internalTalkerInstructions$, sessionBody.talkerInstructions);

    // Baseline-probe task_results (seed cursor so historical results don't
    // get re-narrated by the Talker on re-entry) and active tasks (show
    // current state the user needs to see). Subtitle starts empty on
    // re-entry — the fresh in-call turns will populate it.
    const [taskResultsBaseline, activeTasks] = await Promise.all([
      accept(
        client.readItems({
          params: { id: session.id },
          query: {},
        }),
        [200, 401, 404],
        { toast: false },
      ),
      accept(
        client.listTasks({ params: { id: session.id } }),
        [200, 401, 404],
        { toast: false },
      ),
    ]);
    signal.throwIfAborted();

    if (taskResultsBaseline.status === 200) {
      set(
        internalTaskResultsSinceSeq$,
        maxSeqOf(taskResultsBaseline.body.items),
      );
    }
    if (activeTasks.status === 200) {
      set(internalActiveTasks$, activeTasks.body.tasks);
    }

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

    await set(startAblyLoop$, session.id, sessionSignal);
  },
);

/**
 * Exit voice-chat mode: tear down the WebRTC / microphone / wake-lock /
 * Ably loop. The session row itself is left alone — voice-chat-candidate
 * sessions are stateless, so next time startVoiceChatCandidate$ runs with
 * the same (user, agent) it will resume this one via get-or-create.
 */
export const endVoiceChatCandidate$ = command(({ get, set }) => {
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
  set(internalActiveTasks$, []);
  set(internalTaskResultsSinceSeq$, 0);
  set(internalLastUserMessage$, "");
  set(internalLastAssistantMessage$, "");
  set(internalTalkerInstructions$, "");
  set(internalCurrentAssistantAudioItem$, null);
  set(internalParentSignal$, null);
  set(internalStatus$, "idle");
});
