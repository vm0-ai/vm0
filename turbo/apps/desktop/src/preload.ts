import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAuthApi, DesktopComputerUseApi } from "./desktop-bridge";
import { COMPUTER_USE_CHANNELS } from "./computer-use-ipc-channels";
import { DESKTOP_AUTH_CHANNELS } from "./desktop-auth-ipc-channels";
import type {
  ComputerUseApprovalAction,
  DesktopComputerUseState,
} from "./computer-use-types";

const desktopAuthApi: DesktopAuthApi = {
  openSignIn(): Promise<void> {
    return ipcRenderer.invoke(DESKTOP_AUTH_CHANNELS.openSignIn);
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
  start(): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(COMPUTER_USE_CHANNELS.start);
  },
  requestAccessibilityPermission(): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.requestAccessibilityPermission,
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
  decideCommand(
    action: ComputerUseApprovalAction,
  ): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(COMPUTER_USE_CHANNELS.decideCommand, action);
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
