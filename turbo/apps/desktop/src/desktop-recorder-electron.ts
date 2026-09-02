import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { DESKTOP_RECORDER_CHANNELS } from "./desktop-recorder-ipc-channels";
import { isDesktopRecorderPageUrl } from "./desktop-recorder-page-url";
import type {
  DesktopRecorderArea,
  DesktopRecorderAreaSelection,
  DesktopRecorderAudioChoice,
  DesktopRecorderCapabilities,
  DesktopRecorderCaptureRequest,
  DesktopRecorderState,
  DesktopRecorderWindowChoice,
  DesktopRecorderWindowOption,
} from "./desktop-recorder-types";

interface DesktopRecorderIpcOptions {
  readonly recorderUrl: string;
}

interface DesktopRecorderNativeApi {
  readonly getState: () => DesktopRecorderState;
  readonly getCapabilities: () => Promise<DesktopRecorderCapabilities>;
  readonly startCapture: (
    request: DesktopRecorderCaptureRequest,
  ) => Promise<void>;
  /**
   * Covers every display with a selector. The capture starts from the overlay
   * that drew the region, so the audio choices made in the bar come along now.
   */
  readonly beginAreaSelection: (audio: DesktopRecorderAudioChoice) => void;
  /** Starts the capture for the drawn region, or abandons the selection. */
  readonly completeAreaSelection: (
    selection: DesktopRecorderAreaSelection | null,
  ) => Promise<void>;
  /** Opens the picker and resolves with the chosen window, or `null`. */
  readonly selectWindow: () => Promise<DesktopRecorderWindowChoice | null>;
  readonly listWindowOptions: () => Promise<
    readonly DesktopRecorderWindowOption[]
  >;
  readonly completeWindowSelection: (
    choice: DesktopRecorderWindowChoice | null,
  ) => void;
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly discard: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly cancel: () => void;
  /** Takes the user to the pane where the recording grant is given. */
  readonly openScreenRecordingSettings: () => void;
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

function parseAudioChoice(value: unknown): DesktopRecorderAudioChoice {
  if (
    !isRecord(value) ||
    typeof value.systemAudio !== "boolean" ||
    typeof value.microphone !== "boolean"
  ) {
    throw new Error("A screen recording request needs both audio choices");
  }
  return { systemAudio: value.systemAudio, microphone: value.microphone };
}

function parseStartRequest(value: unknown): DesktopRecorderCaptureRequest {
  const audio = parseAudioChoice(value);
  const kind = isRecord(value) ? value.sourceKind : undefined;
  if (kind === "display") {
    return { ...audio, sourceKind: kind };
  }
  if (kind === "window") {
    if (!isRecord(value) || typeof value.sourceId !== "string") {
      throw new Error("Recording a window needs the window to record");
    }
    return { ...audio, sourceKind: kind, sourceId: value.sourceId };
  }
  throw new Error(`Unsupported screen recording source kind: ${String(kind)}`);
}

function parseAreaSelection(
  value: unknown,
): DesktopRecorderAreaSelection | null {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value.displayId !== "number" ||
    !isArea(value.area)
  ) {
    throw new Error("A selected region must name its display and rectangle");
  }
  return { displayId: value.displayId, area: value.area };
}

function parseWindowChoice(value: unknown): DesktopRecorderWindowChoice | null {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value.sourceId !== "string" ||
    typeof value.title !== "string"
  ) {
    throw new Error("A chosen window must name its source");
  }
  return { sourceId: value.sourceId, title: value.title };
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
  ipcMain.handle(DESKTOP_RECORDER_CHANNELS.getCapabilities, async (event) => {
    assertRecorderPage(event);
    return await api.getCapabilities();
  });
  ipcMain.handle(DESKTOP_RECORDER_CHANNELS.listWindowOptions, async (event) => {
    assertRecorderPage(event);
    return await api.listWindowOptions();
  });
  ipcMain.handle(
    DESKTOP_RECORDER_CHANNELS.startCapture,
    async (event, request: unknown) => {
      assertRecorderPage(event);
      await api.startCapture(parseStartRequest(request));
    },
  );
  ipcMain.handle(
    DESKTOP_RECORDER_CHANNELS.beginAreaSelection,
    (event, audio: unknown) => {
      assertRecorderPage(event);
      api.beginAreaSelection(parseAudioChoice(audio));
    },
  );
  ipcMain.handle(
    DESKTOP_RECORDER_CHANNELS.completeAreaSelection,
    async (event, selection: unknown) => {
      assertRecorderPage(event);
      await api.completeAreaSelection(parseAreaSelection(selection));
    },
  );
  ipcMain.handle(DESKTOP_RECORDER_CHANNELS.selectWindow, async (event) => {
    assertRecorderPage(event);
    return await api.selectWindow();
  });
  ipcMain.handle(
    DESKTOP_RECORDER_CHANNELS.completeWindowSelection,
    (event, choice: unknown) => {
      assertRecorderPage(event);
      api.completeWindowSelection(parseWindowChoice(choice));
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
  ipcMain.handle(
    DESKTOP_RECORDER_CHANNELS.openScreenRecordingSettings,
    (event) => {
      assertRecorderPage(event);
      api.openScreenRecordingSettings();
    },
  );
}
