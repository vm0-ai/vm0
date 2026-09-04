import {
  voiceDraftChunkRanges,
  type VoiceDraftPause,
} from "../voice-draft-audio";
import {
  decodeVoiceDraftPcmWav,
  encodeVoiceDraftPcmWav,
} from "../voice-draft-pcm";

const SAMPLE_RATE = 16_000;

function samples(seconds: number): number {
  return seconds * SAMPLE_RATE;
}

function pause(seconds: number, duration = 0.8): VoiceDraftPause {
  return { seconds, duration, depth: 20 };
}

describe("voiceDraftChunkRanges", () => {
  it("keeps recordings at or below 90 seconds in one request", () => {
    expect(voiceDraftChunkRanges(samples(90), [pause(60)])).toStrictEqual([
      { startSample: 0, endSample: samples(90) },
    ]);
  });

  it("splits long recordings at safe pauses near the 60 second target", () => {
    expect(
      voiceDraftChunkRanges(samples(180), [pause(60), pause(120)]),
    ).toStrictEqual([
      { startSample: 0, endSample: samples(60) },
      { startSample: samples(60), endSample: samples(120) },
      { startSample: samples(120), endSample: samples(180) },
    ]);
  });

  it("keeps a long recording whole rather than cutting through speech", () => {
    expect(voiceDraftChunkRanges(samples(180), [])).toStrictEqual([
      { startSample: 0, endSample: samples(180) },
    ]);
  });

  it("folds a short final stub into the preceding chunk", () => {
    expect(voiceDraftChunkRanges(samples(100), [pause(60)])).toStrictEqual([
      { startSample: 0, endSample: samples(100) },
    ]);
  });
});

describe("voice draft PCM WAV", () => {
  it("round-trips the AudioWorklet sample format", async () => {
    const source = new Float32Array([-1, -0.25, 0, 0.25, 1]);
    const encoded = encodeVoiceDraftPcmWav(source);
    const decoded = decodeVoiceDraftPcmWav(await encoded.arrayBuffer());

    expect(encoded.type).toBe("audio/wav");
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded ?? [])).toStrictEqual([
      expect.closeTo(-1, 4),
      expect.closeTo(-0.25, 4),
      expect.closeTo(0, 4),
      expect.closeTo(0.25, 4),
      expect.closeTo(1, 4),
    ]);
  });
});
