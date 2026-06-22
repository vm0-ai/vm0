import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopAuthApi,
  DesktopComputerUseApi,
  DesktopDeveloperToolsApi,
} from "./desktop-bridge";
import { COMPUTER_USE_CHANNELS } from "./computer-use-ipc-channels";
import { DESKTOP_AUTH_CHANNELS } from "./desktop-auth-ipc-channels";
import { DESKTOP_DEVELOPER_TOOLS_CHANNELS } from "./desktop-developer-tools-ipc-channels";
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
  signOut(): Promise<void> {
    return ipcRenderer.invoke(DESKTOP_AUTH_CHANNELS.signOut);
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
  start(options): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(COMPUTER_USE_CHANNELS.start, options);
  },
  stop(): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(COMPUTER_USE_CHANNELS.stop);
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
  probeAutomationPermission(target): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.probeAutomationPermission,
      target,
    );
  },
  setKeepAwakeEnabled(enabled: boolean): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.setKeepAwakeEnabled,
      enabled,
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
  openAutomationSettings(): Promise<void> {
    return ipcRenderer.invoke(COMPUTER_USE_CHANNELS.openAutomationSettings);
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

const desktopDeveloperToolsApi: DesktopDeveloperToolsApi = {
  getState() {
    return ipcRenderer.invoke(DESKTOP_DEVELOPER_TOOLS_CHANNELS.getState);
  },
  setEnabled(enabled) {
    return ipcRenderer.invoke(
      DESKTOP_DEVELOPER_TOOLS_CHANNELS.setEnabled,
      enabled,
    );
  },
  subscribe(callback: () => void): () => void {
    const listener = (): void => {
      callback();
    };
    ipcRenderer.on(DESKTOP_DEVELOPER_TOOLS_CHANNELS.changed, listener);
    return () => {
      ipcRenderer.off(DESKTOP_DEVELOPER_TOOLS_CHANNELS.changed, listener);
    };
  },
};

contextBridge.exposeInMainWorld("vm0DesktopAuth", desktopAuthApi);
contextBridge.exposeInMainWorld("vm0DesktopComputerUse", desktopComputerUseApi);
contextBridge.exposeInMainWorld(
  "vm0DesktopDeveloperTools",
  desktopDeveloperToolsApi,
);
