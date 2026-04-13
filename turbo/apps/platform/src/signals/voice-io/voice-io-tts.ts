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
const internalAudioElement$ = state<HTMLAudioElement | null>(null);
const internalObjectUrl$ = state<string | null>(null);
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

function supportsMediaSourceMpeg(): boolean {
  return (
    typeof MediaSource !== "undefined" &&
    MediaSource.isTypeSupported("audio/mpeg")
  );
}

function noop() {}

/**
 * Read all chunks from a ReadableStream and append them to a SourceBuffer for
 * progressive audio playback. Returns a promise that resolves when the stream
 * is fully consumed and all chunks have been flushed to the buffer.
 */
function drainStreamIntoSourceBuffer(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sourceBuffer: SourceBuffer,
  signal: AbortSignal,
): Promise<void> {
  const queue: Uint8Array<ArrayBuffer>[] = [];
  let draining = false;

  function flush() {
    if (draining || queue.length === 0 || sourceBuffer.updating) {
      return;
    }
    draining = true;
    const chunk = queue.shift()!;
    sourceBuffer.appendBuffer(chunk);
  }

  sourceBuffer.addEventListener("updateend", () => {
    draining = false;
    flush();
  });

  return (async () => {
    for (;;) {
      if (signal.aborted) {
        break;
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      queue.push(value.slice());
      flush();
    }

    // Wait for remaining buffered data to finish appending
    await new Promise<void>((resolve) => {
      const finish = () => {
        if (queue.length > 0) {
          flush();
          return;
        }
        if (sourceBuffer.updating) {
          return;
        }
        sourceBuffer.removeEventListener("updateend", finish);
        resolve();
      };
      sourceBuffer.addEventListener("updateend", finish);
      finish();
    });
  })();
}

// ---------------------------------------------------------------------------
// Internal commands
// ---------------------------------------------------------------------------

const cleanupAudio$ = command(({ get, set }) => {
  const cleanupFn = get(internalCleanupFn$);
  if (cleanupFn) {
    cleanupFn();
  }

  const audio = get(internalAudioElement$);
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }

  set(internalPlayingMessageId$, null);
  set(internalAudioElement$, null);
  set(internalObjectUrl$, null);
  set(internalCleanupFn$, null);
});

const resetPlaybackState$ = command(({ set }) => {
  set(internalPlayingMessageId$, null);
  set(internalAudioElement$, null);
  set(internalObjectUrl$, null);
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

    if (supportsMediaSourceMpeg() && response.body) {
      // Streaming path: pipe response stream into MediaSource for progressive playback
      const mediaSource = new MediaSource();
      const audio = new Audio();
      const objectUrl = URL.createObjectURL(mediaSource);
      audio.src = objectUrl;

      const reader = response.body.getReader();

      const onEnded = () => {
        set(resetPlaybackState$);
      };
      const onError = () => {
        L.error("Audio playback error");
        set(resetPlaybackState$);
      };

      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);

      set(internalCleanupFn$, () => {
        reader.cancel().catch(noop);
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        if (mediaSource.readyState === "open") {
          mediaSource.endOfStream();
        }
        URL.revokeObjectURL(objectUrl);
      });

      set(internalObjectUrl$, objectUrl);
      set(internalAudioElement$, audio);

      await new Promise<void>((resolve) => {
        mediaSource.addEventListener(
          "sourceopen",
          () => {
            const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
            let playStarted = false;

            sourceBuffer.addEventListener("updateend", () => {
              if (!playStarted) {
                playStarted = true;
                audio.play().catch((error: unknown) => {
                  L.error("Audio play failed", error);
                  set(resetPlaybackState$);
                });
              }
            });

            drainStreamIntoSourceBuffer(reader, sourceBuffer, signal)
              .then(() => {
                if (mediaSource.readyState === "open") {
                  mediaSource.endOfStream();
                }
                resolve();
              })
              .catch((error: unknown) => {
                if (!signal.aborted) {
                  L.error("TTS stream error", error);
                  set(resetPlaybackState$);
                }
                resolve();
              });
          },
          { once: true },
        );
      });
    } else {
      // Fallback: download full blob then play (Safari/iOS or no ReadableStream)
      const blob = await response.blob();
      signal.throwIfAborted();
      const blobUrl = URL.createObjectURL(blob);
      const audio = new Audio(blobUrl);

      const onEnded = () => {
        URL.revokeObjectURL(blobUrl);
        set(resetPlaybackState$);
      };

      const onError = () => {
        L.error("Audio playback error");
        onEnded();
      };

      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);

      set(internalCleanupFn$, () => {
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        URL.revokeObjectURL(blobUrl);
      });

      set(internalObjectUrl$, blobUrl);
      set(internalAudioElement$, audio);

      // eslint-disable-next-line no-restricted-syntax -- audio.play() rejects on browser autoplay restrictions
      try {
        await audio.play();
      } catch (error) {
        L.error("Audio play failed", error);
        onEnded();
      }
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
