/* eslint-disable no-restricted-syntax */
// This file contains a large amount of TRACE_CACHE that needs to be cleaned up in subsequent modifications.
// Additionally, other files must not reference this file to implement file-level no-restricted-syntax operations.

import { command, computed, state } from "ccstate";
import {
  zeroVoiceChatContract,
  type VoiceChatItemRole,
  type VoiceChatTask,
} from "@vm0/api-contracts/contracts/zero-voice-chat";
import {
  jsonParseOr,
  onDomEventFn,
  resetSignal,
  throwIfAbort,
} from "../utils.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { resolveAudioConfig } from "../../lib/voice-io/audio-config.ts";
import { logger } from "../log.ts";

const L = logger("VoiceChatCandidate");

type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";
type BargeInMode = "speech_started" | "transcript_confirmed";

// Model used for the SDP exchange URL. Session config (tools / VAD / etc.) is
// preset server-side in createEphemeralToken — keep this file free of it.
const TALKER_MODEL = "gpt-realtime-2";

const OPENAI_REALTIME_BASE_URL = "https://api.openai.com/v1/realtime";

const TALKER_TOOL_NAMES = [
  "inform_slow_brain",
  "feel_confused",
  "feel_unable",
  "want_to_ask_user",
  "want_to_reject",
  "want_to_apologize",
] as const;
type TalkerToolName = (typeof TALKER_TOOL_NAMES)[number];
type TalkerToolArgs = { prompt?: unknown };

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

function parseTalkerToolArgs(argsJson: string): TalkerToolArgs | null {
  return jsonParseOr<TalkerToolArgs | null>(argsJson, null);
}

const internalStatus$ = state<ConnectionStatus>("idle");
const internalSessionId$ = state<string | null>(null);
const internalError$ = state<string | null>(null);

const internalLastUserMessage$ = state<string>("");
const internalLastAssistantMessage$ = state<string>("");

// Bumped on every Ably tick (and manual refresh). Async computeds that need
// to refetch server-side state depend on this counter.
const vccReload$ = state<number>(0);

const internalBargeInMode$ = state<BargeInMode>("speech_started");

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

/**
 * Active + recently-finished task feed for the Trinity sidebar. Refetches on
 * every Ably tick (via vccReload$). Returns [] until a session is live.
 */
export const vccTaskFeed$ = computed(async (get): Promise<VoiceChatTask[]> => {
  get(vccReload$);
  const sid = get(internalSessionId$);
  if (!sid) {
    return [];
  }
  const createClient = get(zeroClient$);
  const client = createClient(zeroVoiceChatContract);
  const res = await accept(
    client.listTasks({ params: { id: sid } }),
    [200, 401, 404],
    { toast: false },
  );
  if (res.status !== 200) {
    return [];
  }
  return res.body.tasks;
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
    role: VoiceChatItemRole,
    content: string,
    realtimeItemId: string,
    signal: AbortSignal,
  ) => {
    const sid = get(internalSessionId$);
    if (!sid) {
      return;
    }
    const createClient = get(zeroClient$);
    const client = createClient(zeroVoiceChatContract);
    const res = await accept(
      client.appendItem({
        params: { id: sid },
        body: { role, content, realtimeItemId },
        fetchOptions: { signal },
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

    const parsed = parseTalkerToolArgs(argsJson);
    if (!parsed) {
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
    const client = createClient(zeroVoiceChatContract);
    const res = await accept(
      client.createTask({
        params: { id: sid },
        body: { prompt, callId },
        fetchOptions: { signal },
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

function parseRealtimeDCEvent(data: string): RealtimeDCEvent | null {
  return jsonParseOr<RealtimeDCEvent | null>(data, null);
}

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
  async ({ get, set }, event: RealtimeDCEvent, signal: AbortSignal) => {
    if (event.transcript && event.item_id) {
      if (
        get(internalBargeInMode$) === "transcript_confirmed" &&
        event.transcript.trim()
      ) {
        await set(truncateCurrentAssistantAudio$, signal);
      }
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
  async ({ get, set }, data: string, signal: AbortSignal) => {
    const event = parseRealtimeDCEvent(data);
    if (!event) {
      L.warn("Failed to parse realtime data channel event", { data });
      return;
    }

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
        if (get(internalBargeInMode$) === "speech_started") {
          await set(truncateCurrentAssistantAudio$, signal);
        }
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
      // Session config (modalities / instructions / transcription / VAD /
      // tools) is preset server-side when minting the ephemeral token — see
      // createEphemeralToken. The client no longer pushes session.update on
      // open; pushTalkerInstructions$ still runs on Reasoner-driven updates.
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
        signal,
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
// Talker instructions sync
// ---------------------------------------------------------------------------

/**
 * Fetch the latest talkerInstructions from the server and push them to the
 * Realtime session via the DataChannel. The browser holds no cached copy —
 * the server is the source of truth, and this command is the only path that
 * updates the live session's instructions after the initial token preset.
 */
const syncTalkerInstructions$ = command(
  async ({ get }, signal: AbortSignal) => {
    const sid = get(internalSessionId$);
    const dc = get(internalDc$);
    if (!sid || !dc || dc.readyState !== "open") {
      return;
    }
    const createClient = get(zeroClient$);
    const client = createClient(zeroVoiceChatContract);
    const res = await accept(
      client.getSession({ params: { id: sid }, fetchOptions: { signal } }),
      [200, 401, 404],
      { toast: false },
    );
    signal.throwIfAborted();
    if (res.status !== 200 || dc.readyState !== "open") {
      return;
    }
    dc.send(
      JSON.stringify({
        type: "session.update",
        session: { instructions: res.body.talkerInstructions },
      }),
    );
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
      // One signal drives two things: bump the counter so async computeds
      // (vccTaskFeed$) refetch, and push fresh instructions to the live DC
      // session. Data is the server's truth — the browser caches nothing.
      set(vccReload$, (n) => {
        return n + 1;
      });
      await set(syncTalkerInstructions$, loopSignal);
      return false;
    });

    // Prime once before subscribing so instructions reach the live DC session
    // immediately. `setAblyLoop$` no longer primes its subscribers.
    const done = await set(pollBody$, signal);
    if (done) {
      return;
    }
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
      await lock.release();
      return;
    }
    set(internalWakeLock$, lock);
    lock.addEventListener(
      "release",
      onDomEventFn(async () => {
        if (
          !signal.aborted &&
          reacquireCount < MAX_WAKE_LOCK_REACQUIRE_ATTEMPTS
        ) {
          reacquireCount++;
          await requestAndTrack();
        }
      }),
    );
  };

  signal.throwIfAborted();

  const onVisibilityChange = onDomEventFn(async () => {
    if (document.visibilityState === "visible" && !signal.aborted) {
      reacquireCount = 0;
      await requestAndTrack();
    }
  });
  document.addEventListener("visibilitychange", onVisibilityChange);
  signal.addEventListener("abort", () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });

  await requestAndTrack();
});

const releaseWakeLock$ = command(async ({ get, set }, signal: AbortSignal) => {
  const lock = get(internalWakeLock$);
  if (lock) {
    await lock.release();
    signal.throwIfAborted();
    set(internalWakeLock$, null);
  }
});

// ---------------------------------------------------------------------------
// Microphone recovery (re-acquire tracks after any OS audio interruption)
// ---------------------------------------------------------------------------

const recoverMicrophone$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const pc = get(internalPc$);
    if (!pc || pc.connectionState === "closed") {
      return;
    }
    let newStream: MediaStream;
    try {
      const audioConfig = await resolveAudioConfig();
      signal.throwIfAborted();
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConfig.constraints,
      });
    } catch (error) {
      throwIfAbort(error);
      set(internalError$, "Microphone access lost. Please reconnect.");
      set(internalStatus$, "error");
      return;
    }
    signal.throwIfAborted();
    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack) {
      for (const t of newStream.getTracks()) {
        t.stop();
      }
      return;
    }
    const sender = pc.getSenders().find((s) => {
      return s.track?.kind === "audio";
    });
    if (sender) {
      try {
        await sender.replaceTrack(newTrack);
      } catch (error) {
        throwIfAbort(error);
        for (const t of newStream.getTracks()) {
          t.stop();
        }
        set(internalError$, "Microphone access lost. Please reconnect.");
        set(internalStatus$, "error");
        return;
      }
    }
    signal.throwIfAborted();
    const oldStream = get(internalStream$);
    if (oldStream) {
      for (const t of oldStream.getTracks()) {
        t.stop();
      }
    }
    set(internalStream$, newStream);
    L.info("microphone recovered after audio interruption");
  },
);

const monitorMicrophoneRecovery$ = command(
  ({ get, set }, signal: AbortSignal): void => {
    let recovering = false;

    // Forward-declare so triggerRecovery can reference it before the assignment.
    let watchCurrentTracks: () => void = () => {
      return undefined;
    };

    const triggerRecovery = async (): Promise<void> => {
      if (signal.aborted || recovering) {
        return;
      }
      recovering = true;
      try {
        await set(recoverMicrophone$, signal);
      } finally {
        recovering = false;
      }
      watchCurrentTracks();
    };

    // Attach "ended" listeners to the current stream's audio tracks so any OS
    // audio interruption (notification center pull-down, screen auto-dim) fires
    // recovery immediately without waiting for a visibility change.
    watchCurrentTracks = (): void => {
      const stream = get(internalStream$);
      if (!stream) {
        return;
      }
      for (const track of stream.getAudioTracks()) {
        if (track.readyState === "ended") {
          continue;
        }
        track.addEventListener("ended", onDomEventFn(triggerRecovery), {
          once: true,
        });
      }
    };

    watchCurrentTracks();

    // Visibility-change fallback: handles screen-lock resume and any gap
    // where the track ended before the listener was attached.
    const onVisibilityChange = onDomEventFn(() => {
      if (document.visibilityState !== "visible" || signal.aborted) {
        return;
      }
      const stream = get(internalStream$);
      if (!stream) {
        return;
      }
      const tracks = stream.getAudioTracks();
      const isDead =
        tracks.length > 0 &&
        tracks.every((t) => {
          return t.readyState === "ended";
        });
      if (!isDead) {
        // Re-attach listeners to current tracks (covers fresh tracks post-recovery).
        watchCurrentTracks();
        return;
      }
      return triggerRecovery();
    });
    document.addEventListener("visibilitychange", onVisibilityChange);
    signal.addEventListener("abort", () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    });
  },
);

// ---------------------------------------------------------------------------
// Public commands
// ---------------------------------------------------------------------------

export const startVoiceChatCandidate$ = command(
  async ({ get, set }, agentId: string, signal: AbortSignal) => {
    const status = get(internalStatus$);
    if (status === "connecting" || status === "connected") {
      return;
    }

    set(internalStatus$, "connecting");
    set(internalError$, null);
    set(internalLastUserMessage$, "");
    set(internalLastAssistantMessage$, "");
    set(internalBargeInMode$, "speech_started");
    set(internalCurrentAssistantAudioItem$, null);
    set(internalSessionId$, null);
    set(vccReload$, (n) => {
      return n + 1;
    });

    const sessionSignal = set(resetSessionSignal$, signal);

    const createClient = get(zeroClient$);
    const client = createClient(zeroVoiceChatContract);

    // createSession is get-or-create on the server side: same (userId,
    // agentId) returns the existing session row, so this doubles as resume.
    const res = await accept(
      client.createSession({
        body: { agentId },
        fetchOptions: { signal },
      }),
      [200, 400, 401, 403],
      { toast: false },
    );
    signal.throwIfAborted();
    if (res.status !== 200) {
      set(internalError$, res.body.error.message);
      set(internalStatus$, "error");
      return;
    }
    const session = res.body.session;
    set(internalSessionId$, session.id);
    // Bump so vccTaskFeed$ refetches with the new sessionId.
    set(vccReload$, (n) => {
      return n + 1;
    });

    // Resolve adaptive audio config (echo-cancellation constraints for
    // getUserMedia + noise-reduction hint for the Realtime session). Done
    // per connection so plugging in headphones between calls takes effect.
    const audioConfig = await resolveAudioConfig();
    signal.throwIfAborted();
    set(internalBargeInMode$, audioConfig.bargeInMode);

    const tokenRes = await accept(
      client.token({
        fetchOptions: { signal },
        body: {
          sessionId: session.id,
          noiseReduction: audioConfig.noiseReduction,
        },
      }),
      [200, 400, 401, 403, 404, 500, 503],
      { toast: false },
    );
    signal.throwIfAborted();

    if (tokenRes.status !== 200) {
      set(internalError$, tokenRes.body.error.message);
      set(internalStatus$, "error");
      return;
    }

    // Sub-issue #12142 will rewire the client onto the relay branch. Until
    // then this client only understands the legacy OpenAI shape; the relay
    // shape only ships when VoiceChatRealtimeBilling is ON for this user.
    if (!("client_secret" in tokenRes.body)) {
      set(
        internalError$,
        "Voice-chat relay is not supported by this client yet",
      );
      set(internalStatus$, "error");
      return;
    }
    const { client_secret: clientSecret } = tokenRes.body;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConfig.constraints,
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

    set(monitorMicrophoneRecovery$, sessionSignal);

    await set(startAblyLoop$, session.id, sessionSignal);
  },
);

/**
 * Exit voice-chat mode: tear down the WebRTC / microphone / wake-lock /
 * Ably loop. The session row itself is left alone — voice-chat-candidate
 * sessions are stateless, so next time startVoiceChatCandidate$ runs with
 * the same (user, agent) it will resume this one via get-or-create.
 */
export const endVoiceChatCandidate$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(resetSessionSignal$);
    await set(releaseWakeLock$, signal);

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
    set(internalLastUserMessage$, "");
    set(internalLastAssistantMessage$, "");
    set(internalBargeInMode$, "speech_started");
    set(internalCurrentAssistantAudioItem$, null);
    set(internalStatus$, "idle");
    // Bump so vccTaskFeed$ re-resolves to [] after sessionId is cleared.
    set(vccReload$, (n) => {
      return n + 1;
    });
  },
);
