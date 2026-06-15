import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_USE_CHANNELS } from "./computer-use-ipc-channels";
import { DESKTOP_AUTH_CHANNELS } from "./desktop-auth-ipc-channels";
import type { DesktopAuthApi, DesktopComputerUseApi } from "./desktop-bridge";

type ExposeInMainWorld = (key: string, api: unknown) => void;
type IpcInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;
type IpcListener = (...args: unknown[]) => void;
type IpcOn = (channel: string, listener: IpcListener) => void;
type IpcOff = (channel: string, listener: IpcListener) => void;

const electronMock = vi.hoisted(() => {
  const exposed = new Map<string, unknown>();
  const listeners = new Map<string, Set<IpcListener>>();
  const exposeInMainWorld = vi.fn<ExposeInMainWorld>((key, api) => {
    exposed.set(key, api);
  });
  const invoke = vi.fn<IpcInvoke>(async () => {
    return undefined;
  });
  const on = vi.fn<IpcOn>((channel, listener) => {
    const channelListeners = listeners.get(channel) ?? new Set<IpcListener>();
    channelListeners.add(listener);
    listeners.set(channel, channelListeners);
  });
  const off = vi.fn<IpcOff>((channel, listener) => {
    listeners.get(channel)?.delete(listener);
  });

  return {
    contextBridge: {
      exposeInMainWorld,
    },
    emit(channel: string, ...args: unknown[]): void {
      for (const listener of listeners.get(channel) ?? []) {
        listener(...args);
      }
    },
    exposed,
    ipcRenderer: {
      invoke,
      off,
      on,
    },
    listeners,
  };
});

vi.mock("electron", () => {
  return {
    contextBridge: electronMock.contextBridge,
    ipcRenderer: electronMock.ipcRenderer,
  };
});

beforeEach(() => {
  vi.resetModules();
  electronMock.exposed.clear();
  electronMock.listeners.clear();
  electronMock.contextBridge.exposeInMainWorld.mockClear();
  electronMock.ipcRenderer.invoke.mockClear();
  electronMock.ipcRenderer.off.mockClear();
  electronMock.ipcRenderer.on.mockClear();
});

describe("Desktop preload bridge", () => {
  it("exposes the desktop auth and computer use APIs in the renderer", async () => {
    await loadPreload();

    expect(
      electronMock.contextBridge.exposeInMainWorld.mock.calls.map(([key]) => {
        return key;
      }),
    ).toStrictEqual(["vm0DesktopAuth", "vm0DesktopComputerUse"]);
    expect(exposedApi<DesktopAuthApi>("vm0DesktopAuth")).toBeTruthy();
    expect(
      exposedApi<DesktopComputerUseApi>("vm0DesktopComputerUse"),
    ).toBeTruthy();
  });

  it("routes desktop auth API calls through IPC channels", async () => {
    await loadPreload();
    const auth = exposedApi<DesktopAuthApi>("vm0DesktopAuth");

    await auth.getState();
    await auth.openSignIn();
    await auth.openOrgSelection();
    await auth.signOut();
    await auth.completeSignIn({ token: "desktop_token" });

    expect(electronMock.ipcRenderer.invoke.mock.calls).toStrictEqual([
      [DESKTOP_AUTH_CHANNELS.getState],
      [DESKTOP_AUTH_CHANNELS.openSignIn],
      [DESKTOP_AUTH_CHANNELS.openOrgSelection],
      [DESKTOP_AUTH_CHANNELS.signOut],
      [DESKTOP_AUTH_CHANNELS.completeSignIn, { token: "desktop_token" }],
    ]);
  });

  it("routes computer use API calls through IPC channels", async () => {
    await loadPreload();
    const computerUse = exposedApi<DesktopComputerUseApi>(
      "vm0DesktopComputerUse",
    );

    await computerUse.getState();
    await computerUse.refreshPermissions();
    await computerUse.start({ userInitiated: true });
    await computerUse.stop();
    await computerUse.requestAccessibilityPermission();
    await computerUse.requestScreenRecordingPermission();
    await computerUse.setKeepAwakeEnabled(true);
    await computerUse.openAccessibilitySettings();
    await computerUse.openScreenRecordingSettings();

    expect(electronMock.ipcRenderer.invoke.mock.calls).toStrictEqual([
      [COMPUTER_USE_CHANNELS.getState],
      [COMPUTER_USE_CHANNELS.refreshPermissions],
      [COMPUTER_USE_CHANNELS.start, { userInitiated: true }],
      [COMPUTER_USE_CHANNELS.stop],
      [COMPUTER_USE_CHANNELS.requestAccessibilityPermission],
      [COMPUTER_USE_CHANNELS.requestScreenRecordingPermission],
      [COMPUTER_USE_CHANNELS.setKeepAwakeEnabled, true],
      [COMPUTER_USE_CHANNELS.openAccessibilitySettings],
      [COMPUTER_USE_CHANNELS.openScreenRecordingSettings],
    ]);
  });

  it("cleans up auth and computer use IPC subscriptions", async () => {
    await loadPreload();
    const auth = exposedApi<DesktopAuthApi>("vm0DesktopAuth");
    const computerUse = exposedApi<DesktopComputerUseApi>(
      "vm0DesktopComputerUse",
    );
    const authChanged = vi.fn<() => void>();
    const computerUseChanged = vi.fn<() => void>();

    const unsubscribeAuth = auth.subscribe(authChanged);
    const unsubscribeComputerUse = computerUse.subscribe(computerUseChanged);

    electronMock.emit(DESKTOP_AUTH_CHANNELS.changed, { ignored: true });
    electronMock.emit(COMPUTER_USE_CHANNELS.changed, { ignored: true });

    expect(authChanged).toHaveBeenCalledOnce();
    expect(computerUseChanged).toHaveBeenCalledOnce();

    const authListener = listenerFor(DESKTOP_AUTH_CHANNELS.changed);
    const computerUseListener = listenerFor(COMPUTER_USE_CHANNELS.changed);
    unsubscribeAuth();
    unsubscribeComputerUse();
    electronMock.emit(DESKTOP_AUTH_CHANNELS.changed);
    electronMock.emit(COMPUTER_USE_CHANNELS.changed);

    expect(authChanged).toHaveBeenCalledOnce();
    expect(computerUseChanged).toHaveBeenCalledOnce();
    expect(electronMock.ipcRenderer.off).toHaveBeenCalledWith(
      DESKTOP_AUTH_CHANNELS.changed,
      authListener,
    );
    expect(electronMock.ipcRenderer.off).toHaveBeenCalledWith(
      COMPUTER_USE_CHANNELS.changed,
      computerUseListener,
    );
  });
});

async function loadPreload(): Promise<void> {
  await import("./preload");
}

function exposedApi<T>(key: string): T {
  const api = electronMock.exposed.get(key);
  if (!api) {
    throw new Error(`Expected ${key} to be exposed`);
  }
  return api as T;
}

function listenerFor(channel: string): IpcListener {
  const listener = electronMock.ipcRenderer.on.mock.calls.find((call) => {
    return call[0] === channel;
  })?.[1];
  if (!listener) {
    throw new Error(`Expected listener for ${channel}`);
  }
  return listener;
}
