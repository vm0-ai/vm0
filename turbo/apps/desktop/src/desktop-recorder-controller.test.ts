import { describe, expect, it, vi } from "vitest";
import { DesktopRecorderController } from "./desktop-recorder-controller";
import type { DeliveredRecording } from "./desktop-recorder-delivery";
import type {
  DesktopRecorderNativeStatus,
  DesktopRecorderPrepareResult,
  DesktopRecorderRecording,
  RecorderNativeBackend,
} from "./desktop-recorder-types";

const RECORDING: DesktopRecorderRecording = {
  videoPath: "/tmp/recording.mp4",
  clickTrackPath: "/tmp/recording.clicks.json",
  durationMs: 4200,
  sizeBytes: 1024,
  width: 1920,
  height: 1080,
};

const PREPARED: DesktopRecorderPrepareResult = {
  sessionId: "session-1",
  geometry: {
    originX: 0,
    originY: 0,
    widthPoints: 1512,
    heightPoints: 982,
    scale: 2,
  },
  width: 1920,
  height: 1080,
};

function createBackendFake(
  overrides: Partial<RecorderNativeBackend> = {},
): RecorderNativeBackend {
  return {
    dispose: vi.fn(),
    listSources: vi.fn(async () => ({
      sources: [
        {
          id: "display:1",
          kind: "display" as const,
          title: "Built-in Display",
        },
      ],
      supportsMicrophone: true,
    })),
    prepare: vi.fn(async () => PREPARED),
    start: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
    stop: vi.fn(async () => RECORDING),
    getStatus: vi.fn(
      async (): Promise<DesktopRecorderNativeStatus> => ({
        status: "recording",
        elapsedMs: 1000,
      }),
    ),
    ...overrides,
  };
}

const DELIVERED: DeliveredRecording = {
  videoUploadId: "upload-video",
  clickTrackUploadId: "upload-clicks",
  reviewUrl: "https://app.okou.ai/?intro-video-recording=upload-video",
};

function createController(
  backend: RecorderNativeBackend = createBackendFake(),
  overrides: {
    readonly canDeliver?: () => Promise<boolean>;
    readonly deliver?: () => Promise<DeliveredRecording>;
  } = {},
) {
  const onChange = vi.fn();
  const logError = vi.fn();
  const createBackend = vi.fn(() => backend);
  const openReview = vi.fn();
  const canDeliver = vi.fn(overrides.canDeliver ?? (async () => true));
  const deliver = vi.fn(overrides.deliver ?? (async () => DELIVERED));
  const controller = new DesktopRecorderController({
    createBackend,
    createOutputPath: () => "/tmp/recording.mp4",
    canDeliver,
    deliver,
    openReview,
    onChange,
    logError,
  });
  return {
    controller,
    backend,
    createBackend,
    onChange,
    logError,
    openReview,
    canDeliver,
    deliver,
  };
}

async function enableAndPrepare(controller: DesktopRecorderController) {
  controller.setFeatureEnabled(true);
  await controller.prepare({
    sourceId: "display:1",
    sourceKind: "display",
    systemAudio: true,
    microphone: false,
  });
}

describe("DesktopRecorderController", () => {
  it("stays unavailable and never creates a helper while the switch is off", async () => {
    const { controller, createBackend } = createController();

    expect(controller.getState()).toEqual({
      available: false,
      status: "unavailable",
      sessionId: null,
      elapsedMs: 0,
      error: null,
      lastRecording: null,
    });
    await expect(controller.listSources()).rejects.toThrow(
      "Desktop screen recording is disabled",
    );
    expect(createBackend).not.toHaveBeenCalled();
  });

  it("records end to end and reports the finished file", async () => {
    const { controller, backend } = createController();

    await enableAndPrepare(controller);
    expect(controller.getState().status).toBe("ready");
    expect(controller.getState().sessionId).toBe("session-1");

    await controller.start();
    expect(controller.getState().status).toBe("recording");
    expect(backend.start).toHaveBeenCalledWith(
      "session-1",
      "/tmp/recording.mp4",
    );

    await expect(controller.stop()).resolves.toEqual(RECORDING);
    expect(controller.getState()).toMatchObject({
      status: "idle",
      sessionId: null,
      lastRecording: RECORDING,
    });
  });

  it("uploads the finished recording and opens it for review", async () => {
    const { controller, deliver, openReview } = createController();
    await enableAndPrepare(controller);
    await controller.start();

    await controller.stop();

    expect(deliver).toHaveBeenCalledWith(RECORDING);
    expect(openReview).toHaveBeenCalledWith(DELIVERED.reviewUrl);
    expect(controller.getState()).toMatchObject({
      status: "idle",
      error: null,
    });
  });

  it("refuses to record while signed out, before anything is captured", async () => {
    const { controller, backend } = createController(createBackendFake(), {
      canDeliver: async () => false,
    });
    controller.setFeatureEnabled(true);

    await expect(
      controller.prepare({
        sourceId: "display:1",
        sourceKind: "display",
        systemAudio: true,
        microphone: false,
      }),
    ).rejects.toThrow("Cannot record while signed out of Okou");
    expect(backend.prepare).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({
      status: "idle",
      error: { code: "signed_out" },
    });
  });

  it("keeps the recording and stays retryable when delivery fails", async () => {
    const { controller, openReview } = createController(createBackendFake(), {
      deliver: async () => {
        throw new Error("Uploading recording.mp4 failed with 503");
      },
    });
    await enableAndPrepare(controller);
    await controller.start();

    await expect(controller.stop()).resolves.toEqual(RECORDING);

    expect(openReview).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({
      status: "idle",
      lastRecording: RECORDING,
      error: {
        code: "delivery_failed",
        message: "Uploading recording.mp4 failed with 503",
      },
    });
  });

  it("delivers the same recording again on retry", async () => {
    let attempts = 0;
    const { controller, openReview } = createController(createBackendFake(), {
      deliver: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("network down");
        }
        return DELIVERED;
      },
    });
    await enableAndPrepare(controller);
    await controller.start();
    await controller.stop();

    await controller.retryDelivery();

    expect(attempts).toBe(2);
    expect(openReview).toHaveBeenCalledWith(DELIVERED.reviewUrl);
    expect(controller.getState().error).toBeNull();
  });

  it("has nothing to retry before a recording exists", async () => {
    const { controller } = createController();
    controller.setFeatureEnabled(true);

    await expect(controller.retryDelivery()).rejects.toThrow(
      "There is no recording to deliver",
    );
  });

  it("pauses and resumes a running capture", async () => {
    const { controller, backend } = createController();
    await enableAndPrepare(controller);
    await controller.start();

    await controller.pause();
    expect(backend.pause).toHaveBeenCalledWith("session-1");
    expect(controller.getState().status).toBe("paused");

    await controller.resume();
    expect(backend.resume).toHaveBeenCalledWith("session-1");
    expect(controller.getState().status).toBe("recording");
  });

  it("stops a paused capture without resuming it first", async () => {
    const { controller } = createController();
    await enableAndPrepare(controller);
    await controller.start();
    await controller.pause();

    await expect(controller.stop()).resolves.toEqual(RECORDING);
    expect(controller.getState().status).toBe("idle");
  });

  it("keeps nothing to deliver after a discard", async () => {
    const { controller, backend, deliver } = createController();
    await enableAndPrepare(controller);
    await controller.start();

    await controller.discard();

    expect(backend.discard).toHaveBeenCalledWith("session-1");
    expect(deliver).not.toHaveBeenCalled();
    // A discarded recording must not be reachable through a later retry.
    expect(controller.getState()).toMatchObject({
      status: "idle",
      sessionId: null,
      lastRecording: null,
    });
    await expect(controller.retryDelivery()).rejects.toThrow(
      "There is no recording to deliver",
    );
  });

  it("rejects starting before a session is prepared", async () => {
    const { controller } = createController();
    controller.setFeatureEnabled(true);

    await expect(controller.start()).rejects.toThrow(
      "No prepared screen recording session",
    );
  });

  it("stays usable after the capture permission is denied", async () => {
    const prepare = vi
      .fn<RecorderNativeBackend["prepare"]>()
      .mockRejectedValueOnce(new Error("Screen Recording permission required"))
      .mockResolvedValue(PREPARED);
    const { controller } = createController(createBackendFake({ prepare }));
    controller.setFeatureEnabled(true);

    await expect(
      controller.prepare({
        sourceId: "display:1",
        sourceKind: "display",
        systemAudio: true,
        microphone: false,
      }),
    ).rejects.toThrow("Screen Recording permission required");
    expect(controller.getState().status).toBe("idle");

    await controller.prepare({
      sourceId: "display:1",
      sourceKind: "display",
      systemAudio: true,
      microphone: false,
    });
    expect(controller.getState().status).toBe("ready");
  });

  it("keeps the session stoppable after a failed stop", async () => {
    const stop = vi
      .fn<RecorderNativeBackend["stop"]>()
      .mockRejectedValueOnce(new Error("helper timed out"))
      .mockResolvedValue(RECORDING);
    const { controller } = createController(createBackendFake({ stop }));
    await enableAndPrepare(controller);
    await controller.start();

    await expect(controller.stop()).rejects.toThrow("helper timed out");
    expect(controller.getState()).toMatchObject({
      status: "recording",
      sessionId: "session-1",
    });

    await expect(controller.stop()).resolves.toEqual(RECORDING);
    expect(controller.getState()).toMatchObject({
      status: "idle",
      lastRecording: RECORDING,
    });
  });

  it("surfaces elapsed time from the native helper while recording", async () => {
    const { controller, onChange } = createController();
    await enableAndPrepare(controller);
    await controller.start();
    onChange.mockClear();

    await controller.refreshRecordingStatus();

    expect(controller.getState().elapsedMs).toBe(1000);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("finishes and delivers when the user ends the share from the system indicator", async () => {
    const backend = createBackendFake({
      getStatus: vi.fn(
        async (): Promise<DesktopRecorderNativeStatus> => ({
          status: "stopped",
          elapsedMs: 4200,
        }),
      ),
    });
    const { controller, deliver, openReview } = createController(backend);
    await enableAndPrepare(controller);
    await controller.start();

    await controller.refreshRecordingStatus();

    // The capture is finalized through the same path an explicit stop uses, so
    // the click track is written and the recording is handed over.
    expect(backend.stop).toHaveBeenCalledWith("session-1");
    expect(deliver).toHaveBeenCalledWith(RECORDING);
    expect(openReview).toHaveBeenCalledWith(DELIVERED.reviewUrl);
    expect(controller.getState()).toMatchObject({
      status: "idle",
      sessionId: null,
      error: null,
      lastRecording: RECORDING,
    });
  });

  it("keeps the partial recording when the capture breaks", async () => {
    const backend = createBackendFake({
      getStatus: vi.fn(
        async (): Promise<DesktopRecorderNativeStatus> => ({
          status: "failed",
          elapsedMs: 2000,
          error: { code: "source_lost", message: "Display disconnected" },
        }),
      ),
    });
    const { controller, deliver } = createController(backend);
    await enableAndPrepare(controller);
    await controller.start();

    await controller.refreshRecordingStatus();

    // Finalized so the frames already captured and their click track survive,
    // but not shipped on its own: a broken capture is the user's call.
    expect(backend.stop).toHaveBeenCalledWith("session-1");
    expect(deliver).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({
      status: "idle",
      sessionId: null,
      lastRecording: RECORDING,
      error: { code: "source_lost", message: "Display disconnected" },
    });
  });

  it("can deliver a salvaged recording on request", async () => {
    const backend = createBackendFake({
      getStatus: vi.fn(
        async (): Promise<DesktopRecorderNativeStatus> => ({
          status: "failed",
          elapsedMs: 2000,
          error: { code: "source_lost", message: "Display disconnected" },
        }),
      ),
    });
    const { controller, openReview } = createController(backend);
    await enableAndPrepare(controller);
    await controller.start();
    await controller.refreshRecordingStatus();

    await controller.retryDelivery();

    expect(openReview).toHaveBeenCalledWith(DELIVERED.reviewUrl);
  });

  it("reports the capture reason when the salvage itself fails", async () => {
    const backend = createBackendFake({
      getStatus: vi.fn(
        async (): Promise<DesktopRecorderNativeStatus> => ({
          status: "failed",
          elapsedMs: 2000,
          error: { code: "source_lost", message: "Display disconnected" },
        }),
      ),
      stop: vi.fn(async () => {
        throw new Error("helper is gone");
      }),
    });
    const { controller, logError } = createController(backend);
    await enableAndPrepare(controller);
    await controller.start();

    await controller.refreshRecordingStatus();

    expect(logError).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({
      status: "idle",
      sessionId: null,
      lastRecording: null,
      error: { code: "source_lost" },
    });
  });

  it("finalizes the file and releases the helper when the switch is withdrawn", async () => {
    const { controller, backend } = createController();
    await enableAndPrepare(controller);
    await controller.start();

    controller.setFeatureEnabled(false);

    expect(controller.getState().available).toBeFalsy();
    await vi.waitFor(() => {
      expect(backend.stop).toHaveBeenCalledWith("session-1");
      expect(backend.dispose).toHaveBeenCalledOnce();
    });
  });

  it("still releases the helper when the final stop fails", async () => {
    const backend = createBackendFake({
      stop: vi.fn(async () => {
        throw new Error("helper crashed");
      }),
    });
    const { controller, logError } = createController(backend);
    await enableAndPrepare(controller);
    await controller.start();

    controller.setFeatureEnabled(false);

    await vi.waitFor(() => {
      expect(backend.dispose).toHaveBeenCalledOnce();
      expect(logError).toHaveBeenCalledOnce();
    });
  });
});
