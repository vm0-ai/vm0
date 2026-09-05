import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Rectangle, Size } from "electron";
import type {
  ComputerUseLocalCommandLogEntry,
  ComputerUseHostRuntimeStatus,
  DesktopComputerUseState,
} from "./computer-use-types";
import type { DesktopAuthState } from "./desktop-bridge";
import { UNAVAILABLE_RECORDER_STATE } from "./desktop-recorder-types";
import { DesktopTrayController } from "./desktop-tray";

interface MockNativeImage {
  readonly path: string;
  readonly cropRect: Rectangle | null;
  readonly getSize: () => Size;
  readonly crop: (rect: Rectangle) => MockNativeImage;
  templateImage: boolean;
  readonly setTemplateImage: ReturnType<typeof vi.fn<(value: boolean) => void>>;
}

interface MockTrayInstance {
  image: MockNativeImage;
  readonly setToolTip: ReturnType<typeof vi.fn<(tooltip: string) => void>>;
  readonly setContextMenu: ReturnType<typeof vi.fn<(menu: unknown) => void>>;
  readonly setImage: ReturnType<typeof vi.fn<(image: MockNativeImage) => void>>;
}

const electronMock = vi.hoisted(() => {
  const trays: MockTrayInstance[] = [];

  function createImage(
    iconPath: string,
    cropRect: Rectangle | null = null,
  ): MockNativeImage {
    const image: MockNativeImage = {
      path: iconPath,
      cropRect,
      getSize: () => ({
        width:
          cropRect?.width ?? (iconPath.endsWith("Running.png") ? 1_080 : 18),
        height: cropRect?.height ?? 18,
      }),
      crop: (rect) => createImage(iconPath, rect),
      templateImage: false,
      setTemplateImage: vi.fn<(value: boolean) => void>((value) => {
        image.templateImage = value;
      }),
    };
    return image;
  }

  class MockTray implements MockTrayInstance {
    image: MockNativeImage;
    readonly setToolTip = vi.fn<(tooltip: string) => void>();
    readonly setContextMenu = vi.fn<(menu: unknown) => void>();
    readonly setImage = vi.fn<(image: MockNativeImage) => void>((image) => {
      this.image = image;
    });

    constructor(image: MockNativeImage) {
      this.image = image;
      trays.push(this);
    }
  }

  return {
    Menu: {
      buildFromTemplate: vi.fn((template: unknown) => {
        return { template };
      }),
    },
    Tray: MockTray,
    nativeImage: {
      createFromPath: vi.fn<(iconPath: string) => MockNativeImage>((iconPath) =>
        createImage(iconPath),
      ),
    },
    trays,
  };
});

vi.mock("electron", () => {
  return {
    Menu: electronMock.Menu,
    Tray: electronMock.Tray,
    nativeImage: electronMock.nativeImage,
  };
});

const originalPlatform = process.platform;
const iconPath = "/assets/tray-iconTemplate.png";
const disabledIconPath = "/assets/tray-iconDisabled.png";
const runningIconPath = "/assets/tray-iconRunning.png";

const signedInAuth: DesktopAuthState = {
  status: "signed_in",
  user: {
    userId: "user_1",
    email: "user@example.com",
  },
  organization: {
    id: "org_1",
    name: "Max & Zoe",
  },
};

interface ComputerUseStateOptions {
  readonly runningCommand?: boolean;
}

function runningLocalCommandLogEntry(): ComputerUseLocalCommandLogEntry {
  return {
    commandId: "cmd_1",
    kind: "app.state",
    app: null,
    status: "running",
    payload: {},
    result: null,
    error: null,
    startedAt: "2026-06-17T00:00:00.000Z",
    completedAt: null,
    durationMs: null,
  };
}

function computerUseState(
  status: ComputerUseHostRuntimeStatus,
  options: ComputerUseStateOptions = {},
): DesktopComputerUseState {
  return {
    platform: "darwin",
    supported: true,
    permissions: {
      accessibility: true,
      screenRecording: true,
    },
    host: {
      status,
      hostId: status === "online" ? "host_1" : null,
      lastHeartbeatAt: null,
      lastCommandAt: null,
      lastError: null,
      recovery: null,
      errorLog: [],
      localCommandLog: options.runningCommand
        ? [runningLocalCommandLogEntry()]
        : [],
    },
    keepAwake: {
      enabled: false,
      active: false,
    },
  };
}

function installController(getState: () => DesktopComputerUseState) {
  const controller = new DesktopTrayController({
    brandName: "Okou",
    displayName: "Okou",
    iconPath,
    disabledIconPath,
    runningIconPath,
    getComputerUseState: getState,
    getAuthState: async () => signedInAuth,
    showMainWindow: vi.fn(async () => {}),
    startComputerUse: vi.fn(async () => {}),
    stopComputerUse: vi.fn(async () => {}),
    refreshStatus: vi.fn(async () => {}),
    openSignIn: vi.fn(),
    switchWorkspace: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    requestAccessibilityPermission: vi.fn(async () => {}),
    requestScreenRecordingPermission: vi.fn(async () => {}),
    openAccessibilitySettings: vi.fn(),
    openScreenRecordingSettings: vi.fn(),
    setKeepAwakeEnabled: vi.fn(async () => {}),
    getRecorderState: () => UNAVAILABLE_RECORDER_STATE,
    startScreenRecording: vi.fn(async () => {}),
    stopScreenRecording: vi.fn(async () => {}),
    retryScreenRecordingDelivery: vi.fn(async () => {}),
    quit: vi.fn(),
  });
  controller.install();
  return controller;
}

function installedTray(): MockTrayInstance {
  const tray = electronMock.trays[0];
  if (!tray) {
    throw new Error("Expected a desktop tray to be installed");
  }
  return tray;
}

describe("desktop tray", () => {
  beforeEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    electronMock.trays.length = 0;
    electronMock.Menu.buildFromTemplate.mockClear();
    electronMock.nativeImage.createFromPath.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it.each<ComputerUseHostRuntimeStatus>([
    "offline",
    "connecting",
    "recovering",
    "unauthenticated",
    "needs_organization",
    "disabled",
    "error",
  ])("uses the disabled tray icon while Computer Use is %s", (status) => {
    installController(() => computerUseState(status));

    const tray = installedTray();

    expect(tray.image.path).toBe(disabledIconPath);
    expect(tray.image.templateImage).toBe(false);
  });

  it("uses the template tray icon while Computer Use is online", () => {
    installController(() => computerUseState("online"));

    const tray = installedTray();

    expect(tray.image.path).toBe(iconPath);
    expect(tray.image.templateImage).toBe(true);
  });

  it("updates the tray icon when Computer Use moves online or offline", () => {
    let status: ComputerUseHostRuntimeStatus = "offline";
    const controller = installController(() => computerUseState(status));
    const tray = installedTray();

    expect(tray.image.path).toBe(disabledIconPath);
    expect(tray.setImage).not.toHaveBeenCalled();

    status = "online";
    controller.refresh();

    expect(tray.image.path).toBe(iconPath);
    expect(tray.image.templateImage).toBe(true);
    expect(tray.setImage).toHaveBeenCalledTimes(1);

    status = "error";
    controller.refresh();

    expect(tray.image.path).toBe(disabledIconPath);
    expect(tray.image.templateImage).toBe(false);
    expect(tray.setImage).toHaveBeenCalledTimes(2);
  });

  it("cycles orange rotation frames while a local Computer Use command is running", () => {
    vi.useFakeTimers();

    let status: ComputerUseHostRuntimeStatus = "online";
    const controller = installController(() =>
      computerUseState(status, { runningCommand: true }),
    );
    const tray = installedTray();
    const initialImage = tray.image;

    expect(tray.image.path).toBe(runningIconPath);
    expect(tray.image.cropRect).toEqual({
      x: 0,
      y: 0,
      width: 18,
      height: 18,
    });
    expect(tray.image.templateImage).toBe(false);

    for (let index = 1; index < 60; index += 1) {
      vi.advanceTimersByTime(50);

      expect(tray.image.path).toBe(runningIconPath);
      expect(tray.image.cropRect).toEqual({
        x: index * 18,
        y: 0,
        width: 18,
        height: 18,
      });
      expect(tray.image.templateImage).toBe(false);
    }

    vi.advanceTimersByTime(50);

    expect(tray.image).toBe(initialImage);

    status = "offline";
    controller.refresh();

    expect(tray.image.path).toBe(disabledIconPath);
    expect(vi.getTimerCount()).toBe(0);

    status = "online";
    controller.refresh();

    expect(tray.image).toBe(initialImage);
    expect(vi.getTimerCount()).toBe(1);

    status = "offline";
    controller.refresh();
  });

  it("keeps animating during the command gap window", () => {
    vi.useFakeTimers();

    let runningCommand = true;
    const controller = installController(() =>
      computerUseState("online", { runningCommand }),
    );
    const tray = installedTray();

    runningCommand = false;
    controller.refresh();
    vi.advanceTimersByTime(14_500);

    expect(tray.image.path).toBe(runningIconPath);
    expect(tray.image.templateImage).toBe(false);

    vi.advanceTimersByTime(500);

    expect(tray.image.path).toBe(iconPath);
    expect(tray.image.templateImage).toBe(true);
  });
});
