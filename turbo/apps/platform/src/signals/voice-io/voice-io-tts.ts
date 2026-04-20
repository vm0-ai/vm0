import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { fetchTtsAudio } from "../../lib/voice-io/tts-fetch.ts";
import { logger } from "../log.ts";

const L = logger("AudioOutput:TTS");

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const internalPlayingRunId$ = state<string | null>(null);
const internalCleanupFn$ = state<(() => void) | null>(null);

// ---------------------------------------------------------------------------
// Public computed
// ---------------------------------------------------------------------------

export const ttsPlayingRunId$ = computed((get) => {
  return get(internalPlayingRunId$);
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

  set(internalPlayingRunId$, null);
  set(internalCleanupFn$, null);
});

const resetPlaybackState$ = command(({ set }) => {
  set(internalPlayingRunId$, null);
  set(internalCleanupFn$, null);
});

const fetchAndPlay$ = command(
  async ({ get, set }, runId: string, text: string, signal: AbortSignal) => {
    set(cleanupAudio$);
    set(internalPlayingRunId$, runId);

    const plainText = stripMarkdown(text);
    if (!plainText) {
      set(internalPlayingRunId$, null);
      return;
    }

    const fetchFn = get(fetch$);

    // Create AudioContext synchronously during user gesture so the browser
    // grants autoplay permission (transient activation window is ~5 s).
    const audioCtx = new AudioContext({ sampleRate: 24_000 });

    // eslint-disable-next-line no-restricted-syntax -- catch-all to guarantee state cleanup on abort
    try {
      let response: Response | null;
      // eslint-disable-next-line no-restricted-syntax -- raw fetch for binary audio (not a ts-rest contract)
      try {
        response = await fetchTtsAudio(fetchFn, plainText, signal);
      } catch (error) {
        L.error("TTS fetch failed", error);
        await audioCtx.close();
        signal.throwIfAborted();
        set(internalPlayingRunId$, null);
        return;
      }

      if (!response) {
        L.error("TTS API returned error");
        await audioCtx.close();
        signal.throwIfAborted();
        set(internalPlayingRunId$, null);
        return;
      }

      const body = response.body;
      if (!body) {
        await audioCtx.close();
        signal.throwIfAborted();
        set(internalPlayingRunId$, null);
        return;
      }

      // Safety fallback: resume if the context did not auto-start (e.g. auto-read path).
      await audioCtx.resume();
      signal.throwIfAborted();
      const reader = body.getReader();
      let nextStartTime = audioCtx.currentTime;
      let lastSource: AudioBufferSourceNode | null = null;
      let carry: Uint8Array | null = null;

      const cleanupFn = () => {
        reader.cancel().catch((error: unknown) => {
          L.debug("reader cancel error", error);
        });
        audioCtx.close().catch((error: unknown) => {
          L.debug("audioCtx close error", error);
        });
      };
      set(internalCleanupFn$, () => {
        return cleanupFn;
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

        // Convert Int16LE PCM to Float32 (use aligned buffer to avoid RangeError)
        const aligned =
          chunk.buffer.byteLength === chunk.length && chunk.byteOffset === 0
            ? chunk.buffer
            : chunk.buffer.slice(
                chunk.byteOffset,
                chunk.byteOffset + chunk.length,
              );
        const int16 = new Int16Array(aligned);
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
    } catch (error) {
      // Always reset playback state on any error (including AbortError)
      // to prevent the message ID from getting stuck, which would block
      // future playback of the same message.
      set(cleanupAudio$);
      throw error;
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
  async ({ get, set }, runId: string, text: string, signal: AbortSignal) => {
    if (get(internalPlayingRunId$) === runId) {
      return;
    }
    await set(fetchAndPlay$, runId, text, signal);
  },
);
