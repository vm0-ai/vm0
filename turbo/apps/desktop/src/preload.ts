import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAuthApi, DesktopComputerUseApi } from "./desktop-bridge";
import { COMPUTER_USE_CHANNELS } from "./computer-use-ipc-channels";
import { DESKTOP_AUTH_CHANNELS } from "./desktop-auth-ipc-channels";
import type { DesktopComputerUseState } from "./computer-use-types";

const desktopAuthApi: DesktopAuthApi = {
  getState() {
    return ipcRenderer.invoke(DESKTOP_AUTH_CHANNELS.getState);
  },
  openSignIn(): Promise<void> {
    return ipcRenderer.invoke(DESKTOP_AUTH_CHANNELS.openSignIn);
  },
  openOrgSelection(): Promise<void> {
    return ipcRenderer.invoke(DESKTOP_AUTH_CHANNELS.openOrgSelection);
  },
  completeSignIn(params): Promise<void> {
    return ipcRenderer.invoke(DESKTOP_AUTH_CHANNELS.completeSignIn, params);
  },
  subscribe(callback: () => void): () => void {
    const listener = (): void => {
      callback();
    };
    ipcRenderer.on(DESKTOP_AUTH_CHANNELS.changed, listener);
    return () => {
      ipcRenderer.off(DESKTOP_AUTH_CHANNELS.changed, listener);
    };
  },
};

const desktopComputerUseApi: DesktopComputerUseApi = {
  getState(): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(COMPUTER_USE_CHANNELS.getState);
  },
  refreshPermissions(): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(COMPUTER_USE_CHANNELS.refreshPermissions);
  },
  start(): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(COMPUTER_USE_CHANNELS.start);
  },
  requestAccessibilityPermission(): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.requestAccessibilityPermission,
    );
  },
  requestScreenRecordingPermission(): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.requestScreenRecordingPermission,
    );
  },
  openAccessibilitySettings(): Promise<void> {
    return ipcRenderer.invoke(COMPUTER_USE_CHANNELS.openAccessibilitySettings);
  },
  openScreenRecordingSettings(): Promise<void> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.openScreenRecordingSettings,
    );
  },
  subscribe(callback: () => void): () => void {
    const listener = (): void => {
      callback();
    };
    ipcRenderer.on(COMPUTER_USE_CHANNELS.changed, listener);
    return () => {
      ipcRenderer.off(COMPUTER_USE_CHANNELS.changed, listener);
    };
  },
};

contextBridge.exposeInMainWorld("vm0DesktopAuth", desktopAuthApi);
contextBridge.exposeInMainWorld("vm0DesktopComputerUse", desktopComputerUseApi);
