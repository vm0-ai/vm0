import { describe, it, expect } from "vitest";
import { getAudioDuration, MIN_SPEECH_BITRATE_BPS } from "../audio-duration";

function fileFromBytes(bytes: Uint8Array, mimeType: string): File {
  return new File([bytes as BlobPart], "test", { type: mimeType });
}

/**
 * Build a minimal valid WebM file with a given Duration (seconds) in Info.
 * Constructs a correct EBML structure that the parser can traverse.
 */
function buildWebmFile(
  durationSeconds: number,
  opts: { floatSize?: 4 | 8 } = {},
): File {
  // Helper: encode an EBML element [vint-ID, vint-size, data]
  function elem(id: number[], data: number[]): number[] {
    const size = encodeVint(data.length);
    return [...id, ...size, ...data];
  }

  // Per WebM spec, Duration is stored in TimecodeScale units (default 1 ms),
  // not nanoseconds. Spec also allows the float to be 4 or 8 bytes — Chrome's
  // MediaRecorder writes the 4-byte form.
  const floatSize = opts.floatSize ?? 8;
  const durationInMs = durationSeconds * 1_000;
  const durBuf = new ArrayBuffer(floatSize);
  if (floatSize === 8) {
    new DataView(durBuf).setFloat64(0, durationInMs, false);
  } else {
    new DataView(durBuf).setFloat32(0, durationInMs, false);
  }
  const durData = [...new Uint8Array(durBuf)];

  const durationEl = elem([0x44, 0x89], durData); // Duration
  // Append a MuxingApp element after Duration so a buggy parser that
  // overruns the declared Duration size would mis-read into MuxingApp bytes
  // (this mirrors Chrome's actual layout).
  const muxingAppEl = elem([0x4d, 0x80], [0x77, 0x65, 0x62]); // "web"
  const infoEl = elem(
    [0x15, 0x49, 0xa9, 0x66],
    [...durationEl, ...muxingAppEl],
  ); // Info
  const segmentContent = infoEl;

  // Segment size: unknown (all-1s vint) for simplicity
  const segmentEl = [
    0x18,
    0x53,
    0x80,
    0x67, // Segment ID
    0xff, // unknown size (vint)
    ...segmentContent,
  ];

  // EBML header elements
  const ebmlContent = [
    ...elem([0x42, 0x86], [0x01]), // EBMLVersion = 1
    ...elem([0x42, 0xf7], [0x01]), // EBMLReadVersion = 1
    ...elem([0x42, 0xf2], [0x04]), // EBMLMaxIDLength = 4
    ...elem([0x42, 0xf3], [0x08]), // EBMLMaxSizeLength = 8
    ...[0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d], // DocType = "webm" (2-byte ID, 1-byte size, 4-byte value)
    ...elem([0x42, 0x87], [0x04]), // DocTypeVersion = 4
    ...elem([0x42, 0x85], [0x02]), // DocTypeReadVersion = 2
  ];

  const full = new Uint8Array([
    0x1a,
    0x45,
    0xdf,
    0xa3, // EBML header ID
    ...encodeVint(ebmlContent.length),
    ...ebmlContent,
    ...segmentEl,
  ]);
  return fileFromBytes(full, "audio/webm");
}

/** Build a minimal valid WAV file with the given duration. */
function buildWavFile(durationSeconds: number): File {
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = (numChannels * bitsPerSample) / 8;
  const dataSize = durationSeconds * sampleRate * bytesPerSample;

  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  return fileFromBytes(new Uint8Array(buf), "audio/wav");
}

// --- helpers ---

function encodeVint(value: number): Uint8Array {
  if (value === 0) return new Uint8Array([0x80]);
  const bytes: number[] = [];
  let v = value;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  // Set the leading bit on the first byte
  bytes[0] = (bytes[0] ?? 0) | (1 << (8 - bytes.length));
  return new Uint8Array(bytes);
}

// --- tests -----------------------------------------------------------------

describe("getAudioDuration", () => {
  describe("WebM", () => {
    it("returns the Duration from Info element in seconds", async () => {
      const file = buildWebmFile(42);
      const duration = await getAudioDuration(file);
      expect(duration).toBe(42);
    });

    it("returns 0 for zero-duration WebM", async () => {
      const file = buildWebmFile(0);
      const duration = await getAudioDuration(file);
      expect(duration).toBe(0);
    });

    it("handles 4-byte Float32 Duration (Chrome MediaRecorder shape)", async () => {
      // Chrome writes Duration as a 4-byte float; the previous parser hard-read
      // 8 bytes (Duration data + MuxingApp header) and produced ~1e21 seconds,
      // which tripped the AUDIO_DURATION_TOO_LONG guard for every Chrome user.
      const file = buildWebmFile(9, { floatSize: 4 });
      const duration = await getAudioDuration(file);
      expect(duration).toBe(9);
    });

    it("returns null for truncated WebM (no Segment)", async () => {
      const header = new Uint8Array([
        0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x02, 0x02, 0x82, 0x01, 0x02,
      ]);
      const file = fileFromBytes(header, "audio/webm");
      const duration = await getAudioDuration(file);
      expect(duration).toBeNull();
    });

    it("returns null for non-EBML data", async () => {
      const bytes = new Uint8Array(100).fill(0xff);
      const file = fileFromBytes(bytes, "audio/webm");
      const duration = await getAudioDuration(file);
      expect(duration).toBeNull();
    });
  });

  describe("WAV", () => {
    it("returns the correct duration for a 10-second WAV", async () => {
      const file = buildWavFile(10);
      const duration = await getAudioDuration(file);
      expect(duration).toBe(10);
    });

    it("returns 0 for zero-duration WAV", async () => {
      const file = buildWavFile(0);
      const duration = await getAudioDuration(file);
      expect(duration).toBe(0);
    });

    it("returns null for non-RIFF data", async () => {
      const bytes = new Uint8Array(100).fill(0x00);
      const file = fileFromBytes(bytes, "audio/wav");
      const duration = await getAudioDuration(file);
      expect(duration).toBeNull();
    });
  });

  describe("fallback (MP3 / MP4 / M4A)", () => {
    it("estimates duration from file size at floor bitrate", async () => {
      // fileSize bytes / (bps / 8) = duration in seconds
      const bytesPerSecond = MIN_SPEECH_BITRATE_BPS / 8; // 1000 bytes/sec
      const size = 42 * bytesPerSecond;
      const file = fileFromBytes(new Uint8Array(size), "audio/mp3");
      const duration = await getAudioDuration(file);
      expect(duration).toBe(42);
    });

    it("rounds up for sub-second estimates", async () => {
      const bytesPerSecond = MIN_SPEECH_BITRATE_BPS / 8; // 1000 bytes/sec
      const size = bytesPerSecond + 1;
      const file = fileFromBytes(new Uint8Array(size), "audio/mp4");
      const duration = await getAudioDuration(file);
      expect(duration).toBe(2);
    });
  });
});
