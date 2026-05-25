import { contextBridge, ipcRenderer } from "electron";
import { COMPUTER_USE_CHANNELS } from "./computer-use-ipc-channels";
import { DESKTOP_WINDOW_CHROME_CHANNELS } from "./desktop-window-chrome-ipc-channels";
import type {
  ComputerUseApprovalAction,
  DesktopComputerUseState,
} from "./computer-use-types";

const desktopComputerUseApi = {
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

const desktopWindowChromeApi = {
  setSidebarCollapsed(collapsed: boolean): Promise<void> {
    return ipcRenderer.invoke(
      DESKTOP_WINDOW_CHROME_CHANNELS.setSidebarCollapsed,
      collapsed,
    );
  },
};

contextBridge.exposeInMainWorld("vm0DesktopComputerUse", desktopComputerUseApi);
contextBridge.exposeInMainWorld(
  "vm0DesktopWindowChrome",
  desktopWindowChromeApi,
);
