import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { DESKTOP_RECORDER_CHANNELS } from "./desktop-recorder-ipc-channels";
import { isDesktopRecorderPageUrl } from "./desktop-recorder-page-url";
import type {
  DesktopRecorderArea,
  DesktopRecorderCaptureKind,
  DesktopRecorderSourceList,
  DesktopRecorderState,
} from "./desktop-recorder-types";

interface DesktopRecorderIpcOptions {
  readonly recorderUrl: string;
}

interface DesktopRecorderStartRequest {
  readonly sourceId: string;
  readonly sourceKind: DesktopRecorderCaptureKind;
  readonly systemAudio: boolean;
  readonly microphone: boolean;
  readonly area?: DesktopRecorderArea;
}

interface DesktopRecorderNativeApi {
  readonly getState: () => DesktopRecorderState;
  readonly listSources: () => Promise<DesktopRecorderSourceList>;
  readonly startCapture: (
    request: DesktopRecorderStartRequest,
  ) => Promise<void>;
  /**
   * Opens the drag-to-select overlay and resolves with the region the user
   * drew, or `null` when they cancelled.
   */
  readonly selectArea: () => Promise<DesktopRecorderArea | null>;
  /** Reports the region the user drew, or `null` when they cancelled. */
  readonly completeAreaSelection: (area: DesktopRecorderArea | null) => void;
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

function parseStartRequest(value: unknown): DesktopRecorderStartRequest {
  if (
    !isRecord(value) ||
    typeof value.sourceId !== "string" ||
    typeof value.systemAudio !== "boolean" ||
    typeof value.microphone !== "boolean"
  ) {
    throw new Error(
      "A screen recording request needs a source and both audio choices",
    );
  }
  const kind = value.sourceKind;
  if (kind !== "display" && kind !== "window" && kind !== "area") {
    throw new Error(
      `Unsupported screen recording source kind: ${String(kind)}`,
    );
  }
  if (kind !== "area") {
    return {
      sourceId: value.sourceId,
      sourceKind: kind,
      systemAudio: value.systemAudio,
      microphone: value.microphone,
    };
  }
  if (!isArea(value.area)) {
    throw new Error("Recording an area needs the selected region");
  }
  return {
    sourceId: value.sourceId,
    sourceKind: kind,
    systemAudio: value.systemAudio,
    microphone: value.microphone,
    area: value.area,
  };
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
  ipcMain.handle(DESKTOP_RECORDER_CHANNELS.cancel, (event) => {
    assertRecorderPage(event);
    api.cancel();
  });
}
