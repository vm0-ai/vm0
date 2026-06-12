import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_USE_CHANNELS } from "./computer-use-ipc-channels";
import type { DesktopComputerUseState } from "./computer-use-types";
import { COMPUTER_USE_FEATURE_SWITCH_KEY } from "./computer-use-types";
import type { DesktopAuthState } from "./desktop-bridge";
import { DESKTOP_AUTH_CHANNELS } from "./desktop-auth-ipc-channels";

type IpcEvent = {
  readonly senderFrame?: {
    readonly url?: string;
  };
};
type IpcHandler = (event: IpcEvent, ...args: unknown[]) => unknown;
type IpcHandle = (channel: string, handler: IpcHandler) => void;
type WebContentsSend = (channel: string) => void;
type OpenExternal = (url: string) => Promise<void>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  const windows: MockBrowserWindow[] = [];
  const handle = vi.fn<IpcHandle>((channel, handler) => {
    handlers.set(channel, handler);
  });
  const getAllWindows = vi.fn<() => readonly MockBrowserWindow[]>(() => {
    return windows;
  });
  const openExternal = vi.fn<OpenExternal>(async () => {});

  return {
    BrowserWindow: {
      getAllWindows,
    },
    handlers,
    ipcMain: {
      handle,
    },
    shell: {
      openExternal,
    },
    windows,
  };
});

vi.mock("electron", () => {
  return {
    BrowserWindow: electronMock.BrowserWindow,
    ipcMain: electronMock.ipcMain,
    shell: electronMock.shell,
  };
});

interface MockBrowserWindow {
  readonly isDestroyed: () => boolean;
  readonly webContents: {
    readonly send: ReturnType<typeof vi.fn<WebContentsSend>>;
  };
}

const rendererUrl = "vm0-desktop://renderer/index.html";
const allowedAppUrl = "https://app.vm0.ai/desktop-auth/callback";
const blockedAppUrl = "https://evil.example/desktop-auth/callback";

beforeEach(() => {
  vi.resetModules();
  electronMock.handlers.clear();
  electronMock.windows.length = 0;
  electronMock.BrowserWindow.getAllWindows.mockClear();
  electronMock.ipcMain.handle.mockClear();
  electronMock.shell.openExternal.mockClear();
});

describe("Desktop IPC boundary", () => {
  it("protects computer use handlers by renderer URL and validates keep-awake payloads", async () => {
    const { installComputerUseIpc } = await import("./computer-use-electron");
    const api = createComputerUseApi();

    installComputerUseIpc(api, { rendererUrl });

    await expect(
      invokeIpc(COMPUTER_USE_CHANNELS.getState, blockedAppUrl),
    ).rejects.toThrow("Desktop Computer Use is unavailable on this page");
    await expect(
      invokeIpc(COMPUTER_USE_CHANNELS.setKeepAwakeEnabled, rendererUrl, "true"),
    ).rejects.toThrow("Desktop keep-awake enabled state must be a boolean");

    await invokeIpc(COMPUTER_USE_CHANNELS.start, rendererUrl, {
      userInitiated: true,
    });
    await invokeIpc(
      COMPUTER_USE_CHANNELS.setKeepAwakeEnabled,
      rendererUrl,
      true,
    );

    expect(api.start).toHaveBeenCalledWith({ userInitiated: true });
    expect(api.setKeepAwakeEnabled).toHaveBeenCalledWith(true);
  });

  it("protects auth handlers by renderer URL, allowed app origins, and token payloads", async () => {
    const { installDesktopAuthIpc } = await import("./desktop-auth-electron");
    const api = createDesktopAuthApi();

    installDesktopAuthIpc(api, {
      rendererUrl,
      allowedAppOrigins: new Set(["https://app.vm0.ai"]),
    });

    await expect(
      invokeIpc(DESKTOP_AUTH_CHANNELS.getState, allowedAppUrl),
    ).rejects.toThrow("Desktop auth is unavailable on this page");
    await expect(
      invokeIpc(DESKTOP_AUTH_CHANNELS.completeSignIn, blockedAppUrl, {
        token: "desktop_token",
      }),
    ).rejects.toThrow("Desktop auth completion is unavailable on this page");
    await expect(
      invokeIpc(DESKTOP_AUTH_CHANNELS.completeSignIn, allowedAppUrl, {
        token: "",
      }),
    ).rejects.toThrow("Desktop auth completion requires a token");

    await invokeIpc(DESKTOP_AUTH_CHANNELS.getState, rendererUrl);
    await invokeIpc(DESKTOP_AUTH_CHANNELS.completeSignIn, allowedAppUrl, {
      token: "desktop_token",
    });

    expect(api.getState).toHaveBeenCalledOnce();
    expect(api.completeSignIn).toHaveBeenCalledWith("desktop_token");
  });

  it("notifies only live windows when computer use state changes", async () => {
    const { notifyDesktopComputerUseChanged } =
      await import("./computer-use-electron");
    const liveWindow = createMockWindow({ destroyed: false });
    const destroyedWindow = createMockWindow({ destroyed: true });
    electronMock.windows.push(liveWindow, destroyedWindow);

    notifyDesktopComputerUseChanged();

    expect(liveWindow.webContents.send).toHaveBeenCalledWith(
      COMPUTER_USE_CHANNELS.changed,
    );
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("notifies only live windows when desktop auth state changes", async () => {
    const { notifyDesktopAuthChanged } =
      await import("./desktop-auth-electron");
    const liveWindow = createMockWindow({ destroyed: false });
    const destroyedWindow = createMockWindow({ destroyed: true });
    electronMock.windows.push(liveWindow, destroyedWindow);

    notifyDesktopAuthChanged();

    expect(liveWindow.webContents.send).toHaveBeenCalledWith(
      DESKTOP_AUTH_CHANNELS.changed,
    );
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
  });
});

function createComputerUseApi(): {
  readonly getState: ReturnType<typeof vi.fn<() => DesktopComputerUseState>>;
  readonly refreshPermissions: ReturnType<
    typeof vi.fn<() => Promise<DesktopComputerUseState>>
  >;
  readonly start: ReturnType<
    typeof vi.fn<
      (options: {
        readonly userInitiated: boolean;
      }) => Promise<DesktopComputerUseState>
    >
  >;
  readonly stop: ReturnType<
    typeof vi.fn<() => Promise<DesktopComputerUseState>>
  >;
  readonly requestAccessibilityPermission: ReturnType<
    typeof vi.fn<() => Promise<DesktopComputerUseState>>
  >;
  readonly requestScreenRecordingPermission: ReturnType<
    typeof vi.fn<() => Promise<DesktopComputerUseState>>
  >;
  readonly setKeepAwakeEnabled: ReturnType<
    typeof vi.fn<(enabled: boolean) => DesktopComputerUseState>
  >;
} {
  const state = createComputerUseState();
  return {
    getState: vi.fn(() => state),
    refreshPermissions: vi.fn(async () => state),
    start: vi.fn(async () => state),
    stop: vi.fn(async () => state),
    requestAccessibilityPermission: vi.fn(async () => state),
    requestScreenRecordingPermission: vi.fn(async () => state),
    setKeepAwakeEnabled: vi.fn(() => state),
  };
}

function createDesktopAuthApi(): {
  readonly getState: ReturnType<typeof vi.fn<() => DesktopAuthState>>;
  readonly openSignIn: ReturnType<typeof vi.fn<() => void>>;
  readonly openOrgSelection: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly signOut: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly completeSignIn: ReturnType<typeof vi.fn<(token: string) => void>>;
} {
  return {
    getState: vi.fn(() => {
      return {
        status: "signed_out",
        user: null,
        organization: null,
      };
    }),
    openSignIn: vi.fn(() => {}),
    openOrgSelection: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    completeSignIn: vi.fn(() => {}),
  };
}

function createComputerUseState(): DesktopComputerUseState {
  return {
    featureSwitchKey: COMPUTER_USE_FEATURE_SWITCH_KEY,
    platform: "darwin",
    supported: true,
    permissions: {
      accessibility: true,
      screenRecording: true,
    },
    host: {
      status: "offline",
      hostId: null,
      lastHeartbeatAt: null,
      lastCommandAt: null,
      lastError: null,
      recovery: null,
      errorLog: [],
      recentAuditEvents: [],
      localCommandLog: [],
    },
    keepAwake: {
      active: false,
      enabled: false,
    },
  };
}

function createMockWindow({
  destroyed,
}: {
  readonly destroyed: boolean;
}): MockBrowserWindow {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      send: vi.fn<WebContentsSend>(() => {}),
    },
  };
}

async function invokeIpc(
  channel: string,
  senderFrameUrl: string,
  ...args: unknown[]
): Promise<unknown> {
  const handler = electronMock.handlers.get(channel);
  if (!handler) {
    throw new Error(`Expected ${channel} to be handled`);
  }
  return await handler(
    {
      senderFrame: {
        url: senderFrameUrl,
      },
    },
    ...args,
  );
}
