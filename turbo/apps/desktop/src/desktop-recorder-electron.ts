import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { DESKTOP_RECORDER_CHANNELS } from "./desktop-recorder-ipc-channels";
import { isDesktopRecorderPageUrl } from "./desktop-recorder-page-url";
import type {
  DesktopRecorderArea,
  DesktopRecorderCaptureRequest,
  DesktopRecorderSourceList,
  DesktopRecorderState,
} from "./desktop-recorder-types";

interface DesktopRecorderIpcOptions {
  readonly recorderUrl: string;
}

interface DesktopRecorderNativeApi {
  readonly getState: () => DesktopRecorderState;
  readonly listSources: () => Promise<DesktopRecorderSourceList>;
  readonly startCapture: (
    request: DesktopRecorderCaptureRequest,
  ) => Promise<void>;
  /**
   * Opens the drag-to-select overlay and resolves with the region the user
   * drew, or `null` when they cancelled.
   */
  readonly selectArea: () => Promise<DesktopRecorderArea | null>;
  /** Reports the region the user drew, or `null` when they cancelled. */
  readonly completeAreaSelection: (area: DesktopRecorderArea | null) => void;
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly discard: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly cancel: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArea(value: unknown): value is DesktopRecorderArea {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.width === "number" &&
    typeof value.height === "number"
  );
}

function parseStartRequest(value: unknown): DesktopRecorderCaptureRequest {
  if (
    !isRecord(value) ||
    typeof value.systemAudio !== "boolean" ||
    typeof value.microphone !== "boolean"
  ) {
    throw new Error(
      "A screen recording request needs a source and both audio choices",
    );
  }
  const audio = {
    systemAudio: value.systemAudio,
    microphone: value.microphone,
  };
  const kind = value.sourceKind;
  if (kind === "display") {
    return { ...audio, sourceKind: kind };
  }
  if (kind === "window") {
    if (typeof value.sourceId !== "string") {
      throw new Error("Recording a window needs the window to record");
    }
    return { ...audio, sourceKind: kind, sourceId: value.sourceId };
  }
  if (kind === "area") {
    if (!isArea(value.area)) {
      throw new Error("Recording an area needs the selected region");
    }
    return { ...audio, sourceKind: kind, area: value.area };
  }
  throw new Error(`Unsupported screen recording source kind: ${String(kind)}`);
}

export function installDesktopRecorderIpc(
  api: DesktopRecorderNativeApi,
  options: DesktopRecorderIpcOptions,
): void {
  // The recorder overlays are the only frames allowed to drive a capture. Any
  // other page reaching these channels is refused rather than trusted.
  const assertRecorderPage = (event: IpcMainInvokeEvent): void => {
    if (
      !isDesktopRecorderPageUrl(
        event.senderFrame?.url ?? "",
        options.recorderUrl,
      )
    ) {
      throw new Error("Screen recording is unavailable on this page");
    }
  };

  ipcMain.handle(DESKTOP_RECORDER_CHANNELS.getState, (event) => {
    assertRecorderPage(event);
    return api.getState();
  });
  ipcMain.handle(DESKTOP_RECORDER_CHANNELS.listSources, async (event) => {
    assertRecorderPage(event);
    return await api.listSources();
  });
  ipcMain.handle(
    DESKTOP_RECORDER_CHANNELS.startCapture,
    async (event, request: unknown) => {
      assertRecorderPage(event);
      await api.startCapture(parseStartRequest(request));
    },
  );
  ipcMain.handle(DESKTOP_RECORDER_CHANNELS.selectArea, async (event) => {
    assertRecorderPage(event);
    return await api.selectArea();
  });
  ipcMain.handle(
    DESKTOP_RECORDER_CHANNELS.completeAreaSelection,
    (event, area: unknown) => {
      assertRecorderPage(event);
      if (area !== null && !isArea(area)) {
        throw new Error("A selected region must be a rectangle or null");
      }
      api.completeAreaSelection(area);
    },
  );
  for (const [channel, run] of [
    [DESKTOP_RECORDER_CHANNELS.pause, api.pause],
    [DESKTOP_RECORDER_CHANNELS.resume, api.resume],
    [DESKTOP_RECORDER_CHANNELS.discard, api.discard],
    [DESKTOP_RECORDER_CHANNELS.stop, api.stop],
  ] as const) {
    ipcMain.handle(channel, async (event) => {
      assertRecorderPage(event);
      await run();
    });
  }

  ipcMain.handle(DESKTOP_RECORDER_CHANNELS.cancel, (event) => {
    assertRecorderPage(event);
    api.cancel();
  });
}
