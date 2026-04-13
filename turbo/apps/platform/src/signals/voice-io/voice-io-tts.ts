import { command, computed, state } from "ccstate";
import { autoReadEnabled$ } from "./voice-io-settings.ts";
import { fetch$ } from "../fetch.ts";
import { fetchTtsAudio } from "../../lib/voice-io/tts-fetch.ts";
import { logger } from "../log.ts";

const L = logger("VoiceIO:TTS");

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const internalPlayingMessageId$ = state<string | null>(null);
const internalAudioElement$ = state<HTMLAudioElement | null>(null);
const internalBlobUrl$ = state<string | null>(null);
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

  const audio = get(internalAudioElement$);
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }

  set(internalPlayingMessageId$, null);
  set(internalAudioElement$, null);
  set(internalBlobUrl$, null);
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

    const plainText = stripMarkdown(text);
    if (!plainText) {
      return;
    }

    const fetchFn = get(fetch$);

    let blob: Blob | null;
    // eslint-disable-next-line no-restricted-syntax -- raw fetch for binary audio (not a ts-rest contract)
    try {
      blob = await fetchTtsAudio(fetchFn, plainText, signal);
    } catch (error) {
      L.error("TTS fetch failed", error);
      return;
    }

    if (!blob) {
      L.error("TTS API returned error");
      return;
    }

    const blobUrl = URL.createObjectURL(blob);
    const audio = new Audio(blobUrl);

    const onEnded = () => {
      URL.revokeObjectURL(blobUrl);
      set(internalPlayingMessageId$, null);
      set(internalAudioElement$, null);
      set(internalBlobUrl$, null);
      set(internalCleanupFn$, null);
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

    set(internalBlobUrl$, blobUrl);
    set(internalAudioElement$, audio);
    set(internalPlayingMessageId$, messageId);

    // eslint-disable-next-line no-restricted-syntax -- audio.play() rejects on browser autoplay restrictions
    try {
      await audio.play();
    } catch (error) {
      L.error("Audio play failed", error);
      onEnded();
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
  async ({ set }, messageId: string, text: string, signal: AbortSignal) => {
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
