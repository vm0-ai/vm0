import { describe, expect, it, vi } from "vitest";
import { DesktopRecorderController } from "./desktop-recorder-controller";
import type { DeliveredRecording } from "./desktop-recorder-delivery";
import type {
  DesktopRecorderNativeStatus,
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

function createBackendFake(
  overrides: Partial<RecorderNativeBackend> = {},
): RecorderNativeBackend {
  return {
    dispose: vi.fn(),
    listSources: vi.fn(async () => [
      { id: "display:1", kind: "display" as const, title: "Built-in Display" },
    ]),
    prepare: vi.fn(async () => ({
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
    })),
    start: vi.fn(async () => {}),
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

  it("prepares and starts the main display in one step", async () => {
    const { controller, backend } = createController();
    controller.setFeatureEnabled(true);

    await controller.startMainDisplayRecording();

    expect(backend.prepare).toHaveBeenCalledWith({
      sourceId: "display:1",
      sourceKind: "display",
      systemAudio: true,
    });
    expect(controller.getState().status).toBe("recording");
  });

  it("ignores windows when picking the main display", async () => {
    const backend = createBackendFake({
      listSources: vi.fn(async () => [
        { id: "window:42", kind: "window" as const, title: "Safari" },
        { id: "display:7", kind: "display" as const, title: "Studio Display" },
      ]),
    });
    const { controller } = createController(backend);
    controller.setFeatureEnabled(true);

    await controller.startMainDisplayRecording();

    expect(backend.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "display:7" }),
    );
  });

  it("reports when there is no display to record", async () => {
    const backend = createBackendFake({
      listSources: vi.fn(async () => []),
    });
    const { controller } = createController(backend);
    controller.setFeatureEnabled(true);

    await expect(controller.startMainDisplayRecording()).rejects.toThrow(
      "No display is available to record",
    );
    expect(backend.prepare).not.toHaveBeenCalled();
    expect(controller.getState().status).toBe("idle");
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

    await expect(controller.startMainDisplayRecording()).rejects.toThrow(
      "Cannot record while signed out of Okou",
    );
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

  it("rejects starting before a session is prepared", async () => {
    const { controller } = createController();
    controller.setFeatureEnabled(true);

    await expect(controller.start()).rejects.toThrow(
      "No prepared screen recording session",
    );
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

  it("ends the session when the capture source disappears", async () => {
    const backend = createBackendFake({
      getStatus: vi.fn(
        async (): Promise<DesktopRecorderNativeStatus> => ({
          status: "failed",
          elapsedMs: 2000,
          error: { code: "source_lost", message: "Display disconnected" },
        }),
      ),
    });
    const { controller } = createController(backend);
    await enableAndPrepare(controller);
    await controller.start();

    await controller.refreshRecordingStatus();

    expect(controller.getState()).toMatchObject({
      status: "idle",
      sessionId: null,
      error: { code: "source_lost", message: "Display disconnected" },
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
