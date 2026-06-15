import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ComputerUseHostRuntimeStatus,
  DesktopComputerUseState,
} from "./computer-use-types";
import type { DesktopAuthState } from "./desktop-bridge";
import { DesktopTrayController } from "./desktop-tray";

interface MockNativeImage {
  readonly path: string;
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
      createFromPath: vi.fn<(iconPath: string) => MockNativeImage>(
        (iconPath) => {
          const image: MockNativeImage = {
            path: iconPath,
            templateImage: false,
            setTemplateImage: vi.fn<(value: boolean) => void>((value) => {
              image.templateImage = value;
            }),
          };
          return image;
        },
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

const signedInAuth: DesktopAuthState = {
  status: "signed_in",
  user: {
    userId: "user_1",
    email: "user@example.com",
  },
  organization: {
    id: "org_1",
    name: "Max & Zoe",
    slug: "max-zoe",
  },
};

function computerUseState(
  status: ComputerUseHostRuntimeStatus,
): DesktopComputerUseState {
  return {
    featureSwitchKey: "computerUse",
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
      recentAuditEvents: [],
      localCommandLog: [],
    },
    keepAwake: {
      enabled: false,
      active: false,
    },
  };
}

function installController(getStatus: () => ComputerUseHostRuntimeStatus) {
  const controller = new DesktopTrayController({
    displayName: "Zero Computer Use",
    iconPath,
    disabledIconPath,
    getComputerUseState: () => computerUseState(getStatus()),
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
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    electronMock.trays.length = 0;
    electronMock.Menu.buildFromTemplate.mockClear();
    electronMock.nativeImage.createFromPath.mockClear();
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
    installController(() => status);

    const tray = installedTray();

    expect(tray.image.path).toBe(disabledIconPath);
    expect(tray.image.templateImage).toBe(false);
  });

  it("uses the template tray icon while Computer Use is online", () => {
    installController(() => "online");

    const tray = installedTray();

    expect(tray.image.path).toBe(iconPath);
    expect(tray.image.templateImage).toBe(true);
  });

  it("updates the tray icon when Computer Use moves online or offline", () => {
    let status: ComputerUseHostRuntimeStatus = "offline";
    const controller = installController(() => status);
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
});
