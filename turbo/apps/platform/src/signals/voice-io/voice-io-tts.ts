import { command, computed, state } from "ccstate";
import { autoReadEnabled$ } from "./voice-io-settings.ts";
import { fetch$ } from "../fetch.ts";
import { fetchTtsAudio } from "../../lib/voice-io/tts-fetch.ts";
import { logger } from "../log.ts";

const L = logger("AudioIO:TTS");

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const internalPlayingMessageId$ = state<string | null>(null);
const internalCleanupFn$ = state<(() => void) | null>(null);

// Auto-read tracking
const internalSeenLoading$ = state<Set<string>>(new Set());
const internalAutoReadTriggered$ = state<Set<string>>(new Set());

// ---------------------------------------------------------------------------
// Public computed
// ---------------------------------------------------------------------------

export const ttsPlayingMessageId$ = computed((get) => {
  return get(internalPlayingMessageId$);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip common markdown formatting to produce natural-sounding TTS input.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^[\s]*[-*+]\s+/gm, "")
    .replace(/^[\s]*\d+\.\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Internal commands
// ---------------------------------------------------------------------------

const cleanupAudio$ = command(({ get, set }) => {
  const cleanupFn = get(internalCleanupFn$);
  if (cleanupFn) {
    cleanupFn();
  }

  set(internalPlayingMessageId$, null);
  set(internalCleanupFn$, null);
});

const resetPlaybackState$ = command(({ set }) => {
  set(internalPlayingMessageId$, null);
  set(internalCleanupFn$, null);
});

const fetchAndPlay$ = command(
  async (
    { get, set },
    messageId: string,
    text: string,
    signal: AbortSignal,
  ) => {
    set(cleanupAudio$);
    set(internalPlayingMessageId$, messageId);

    const plainText = stripMarkdown(text);
    if (!plainText) {
      set(internalPlayingMessageId$, null);
      return;
    }

    const fetchFn = get(fetch$);

    let response: Response | null;
    // eslint-disable-next-line no-restricted-syntax -- raw fetch for binary audio (not a ts-rest contract)
    try {
      response = await fetchTtsAudio(fetchFn, plainText, signal);
    } catch (error) {
      L.error("TTS fetch failed", error);
      set(internalPlayingMessageId$, null);
      return;
    }

    if (!response) {
      L.error("TTS API returned error");
      set(internalPlayingMessageId$, null);
      return;
    }

    const body = response.body;
    if (!body) {
      set(internalPlayingMessageId$, null);
      return;
    }

    const audioCtx = new AudioContext({ sampleRate: 24_000 });
    await audioCtx.resume();
    signal.throwIfAborted();
    const reader = body.getReader();
    let nextStartTime = audioCtx.currentTime;
    let lastSource: AudioBufferSourceNode | null = null;
    let carry: Uint8Array | null = null;

    set(internalCleanupFn$, () => {
      reader.cancel().catch((error: unknown) => {
        L.debug("reader cancel error", error);
      });
      audioCtx.close().catch((error: unknown) => {
        L.debug("audioCtx close error", error);
      });
    });

    for (;;) {
      if (signal.aborted) {
        break;
      }
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        break;
      }

      // Handle byte alignment (PCM = 2 bytes per sample)
      let chunk = value;
      if (carry) {
        const merged = new Uint8Array(carry.length + chunk.length);
        merged.set(carry);
        merged.set(chunk, carry.length);
        chunk = merged;
        carry = null;
      }
      if (chunk.length % 2 !== 0) {
        carry = chunk.slice(-1);
        chunk = chunk.slice(0, -1);
      }
      if (chunk.length === 0) {
        continue;
      }

      // Convert Int16LE PCM to Float32
      const int16 = new Int16Array(
        chunk.buffer,
        chunk.byteOffset,
        chunk.length / 2,
      );
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32_768;
      }

      const audioBuffer = audioCtx.createBuffer(1, float32.length, 24_000);
      audioBuffer.getChannelData(0).set(float32);

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);

      if (nextStartTime < audioCtx.currentTime) {
        nextStartTime = audioCtx.currentTime;
      }
      source.start(nextStartTime);
      nextStartTime += audioBuffer.duration;
      lastSource = source;
    }

    // Detect end of playback
    if (lastSource) {
      lastSource.addEventListener("ended", () => {
        set(resetPlaybackState$);
      });
    } else {
      set(resetPlaybackState$);
    }
  },
);

// ---------------------------------------------------------------------------
// Public commands
// ---------------------------------------------------------------------------

export const stopTts$ = command(({ set }) => {
  set(cleanupAudio$);
});

export const playTts$ = command(
  async (
    { get, set },
    messageId: string,
    text: string,
    signal: AbortSignal,
  ) => {
    if (get(internalPlayingMessageId$) === messageId) {
      return;
    }
    await set(fetchAndPlay$, messageId, text, signal);
  },
);

/**
 * Mark a message as "seen loading" during this session.
 */
export const markMessageLoading$ = command(
  ({ get, set }, messageId: string) => {
    const seen = get(internalSeenLoading$);
    if (!seen.has(messageId)) {
      const next = new Set(seen);
      next.add(messageId);
      set(internalSeenLoading$, next);
    }
  },
);

/**
 * Check if a completed message should be auto-read, and trigger playback.
 */
export const checkAutoRead$ = command(
  async (
    { get, set },
    messageId: string,
    content: string,
    signal: AbortSignal,
  ) => {
    if (!get(autoReadEnabled$)) {
      return;
    }
    if (!get(internalSeenLoading$).has(messageId)) {
      return;
    }
    if (get(internalAutoReadTriggered$).has(messageId)) {
      return;
    }

    const nextTriggered = new Set(get(internalAutoReadTriggered$));
    nextTriggered.add(messageId);
    set(internalAutoReadTriggered$, nextTriggered);

    await set(fetchAndPlay$, messageId, content, signal);
  },
);
