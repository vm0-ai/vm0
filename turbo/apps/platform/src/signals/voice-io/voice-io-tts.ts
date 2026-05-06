import { command } from "ccstate";
import { onDomEventFn, resetSignal } from "../utils.ts";
import { fetch$ } from "../fetch.ts";
import { fetchTtsAudio } from "../../lib/voice-io/tts-fetch.ts";
import { logger } from "../log.ts";

const L = logger("AudioOutput:TTS");

const resetPlay$ = resetSignal();

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

const fetchAndPlay$ = command(
  async ({ get, set }, text: string, parentSignal: AbortSignal) => {
    const signal = set(resetPlay$, parentSignal);

    const plainText = stripMarkdown(text);
    if (!plainText) {
      return;
    }

    const fetchFn = get(fetch$);
    const response = await fetchTtsAudio(fetchFn, plainText, signal);
    if (!response?.body) {
      L.error("TTS API returned error");
      return;
    }

    const audioCtx = new AudioContext({ sampleRate: 24_000 });
    signal.addEventListener(
      "abort",
      onDomEventFn(() => {
        return audioCtx.close();
      }),
    );

    await audioCtx.resume();
    signal.throwIfAborted();
    const reader = response.body.getReader();
    signal.addEventListener(
      "abort",
      onDomEventFn(() => {
        return reader.cancel();
      }),
    );

    let nextStartTime = audioCtx.currentTime;
    let carry: Uint8Array | null = null;

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        break;
      }

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
    }
  },
);

// ---------------------------------------------------------------------------
// Public commands
// ---------------------------------------------------------------------------

export const stopTts$ = command(({ set }) => {
  set(resetPlay$);
});

export const playTts$ = command(
  async ({ set }, text: string, signal: AbortSignal) => {
    await set(fetchAndPlay$, text, signal);
  },
);
