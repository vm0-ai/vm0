import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAudioConfig } from "../audio-config";

function stubNavigator(opts: {
  maxTouchPoints: number;
  userAgent: string;
  devices?: Partial<MediaDeviceInfo>[];
  audioSession?: { type: string };
}): void {
  vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(
    opts.maxTouchPoints,
  );
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(opts.userAgent);
  Object.defineProperty(navigator, "mediaDevices", {
    value: {
      enumerateDevices: vi
        .fn()
        .mockResolvedValue((opts.devices ?? []) as MediaDeviceInfo[]),
    },
    writable: true,
    configurable: true,
  });
  if (opts.audioSession !== undefined) {
    Object.defineProperty(navigator, "audioSession", {
      value: opts.audioSession,
      writable: true,
      configurable: true,
    });
  } else {
    Reflect.deleteProperty(navigator as unknown as object, "audioSession");
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator as unknown as object, "audioSession");
});

describe("resolveAudioConfig", () => {
  it("desktop → far_field and AGC enabled", async () => {
    stubNavigator({
      maxTouchPoints: 0,
      userAgent: "Mozilla/5.0 (Macintosh) Chrome/120",
    });
    const cfg = await resolveAudioConfig();
    expect(cfg.noiseReduction).toBe("far_field");
    expect(cfg.constraints.autoGainControl).toBe(true);
    expect(cfg.constraints.echoCancellation).toBe(true);
    expect(cfg.constraints.noiseSuppression).toBe(true);
  });

  it("mobile with external audio output → far_field and AGC enabled", async () => {
    stubNavigator({
      maxTouchPoints: 5,
      userAgent: "Mozilla/5.0 (Linux; Android 13) Mobile Safari/537.36",
      devices: [
        { kind: "audiooutput", deviceId: "bt-headset-1" },
        { kind: "audiooutput", deviceId: "default" },
      ],
    });
    const cfg = await resolveAudioConfig();
    expect(cfg.noiseReduction).toBe("far_field");
    expect(cfg.constraints.autoGainControl).toBe(true);
  });

  it("mobile speakerphone (no external audio) → near_field and AGC disabled", async () => {
    stubNavigator({
      maxTouchPoints: 5,
      userAgent: "Mozilla/5.0 (Linux; Android 13) Mobile Safari/537.36",
      devices: [{ kind: "audiooutput", deviceId: "default" }],
    });
    const cfg = await resolveAudioConfig();
    expect(cfg.noiseReduction).toBe("near_field");
    expect(cfg.constraints.autoGainControl).toBe(false);
  });

  it("sets navigator.audioSession.type = play-and-record when supported", async () => {
    const audioSession = { type: "auto" };
    stubNavigator({
      maxTouchPoints: 5,
      userAgent: "Mozilla/5.0 (iPhone) Mobile Safari/605",
      devices: [],
      audioSession,
    });
    await resolveAudioConfig();
    expect(audioSession.type).toBe("play-and-record");
  });

  it("ignores empty deviceId entries when counting external outputs", async () => {
    stubNavigator({
      maxTouchPoints: 5,
      userAgent: "Mozilla/5.0 (Linux; Android 13) Mobile Safari/537.36",
      devices: [
        { kind: "audiooutput", deviceId: "" },
        { kind: "audiooutput", deviceId: "default" },
      ],
    });
    const cfg = await resolveAudioConfig();
    expect(cfg.noiseReduction).toBe("near_field");
  });
});
