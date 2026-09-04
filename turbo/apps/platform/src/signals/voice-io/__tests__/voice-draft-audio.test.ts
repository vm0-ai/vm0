import { vi } from "vitest";

import { testContext } from "../../__tests__/test-helpers";
import { createChildAbortController, createDeferredPromise } from "../../utils";
import {
  voiceDraftChunkRanges,
  type VoiceDraftPause,
} from "../voice-draft-audio";
import {
  decodeVoiceDraftPcmWav,
  encodeVoiceDraftPcmWav,
  startVoiceDraftPcmCapture,
} from "../voice-draft-pcm";

const SAMPLE_RATE = 16_000;
const context = testContext();

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

describe("voice draft PCM capture", () => {
  it("closes the AudioContext when startup is aborted", async () => {
    const moduleLoad = createDeferredPromise<void>(context.signal);
    const addModule = vi
      .fn<AudioWorklet["addModule"]>()
      .mockReturnValue(moduleLoad.promise);
    const close = vi.fn<AudioContext["close"]>().mockResolvedValue(undefined);

    class TestAudioContext {
      readonly audioWorklet = { addModule };
      readonly close = close;
    }

    vi.stubGlobal("AudioContext", TestAudioContext);
    vi.stubGlobal("AudioWorkletNode", class TestAudioWorkletNode {});
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:voice-draft-pcm-worklet");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    const startupController = createChildAbortController(context.signal);

    const capture = startVoiceDraftPcmCapture(
      {} as MediaStream,
      startupController.signal,
    );
    await vi.waitFor(() => {
      expect(addModule).toHaveBeenCalledOnce();
    });

    const abortError = new DOMException("Recording stopped", "AbortError");
    startupController.abort(abortError);
    moduleLoad.resolve(undefined);

    await expect(capture).rejects.toBe(abortError);
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith(
      "blob:voice-draft-pcm-worklet",
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
