import { contextBridge, ipcRenderer } from "electron";
import { COMPUTER_USE_CHANNELS } from "./computer-use-ipc-channels";
import { DESKTOP_LOCAL_AGENT_CHANNELS } from "./desktop-local-agent-ipc-channels";
import type {
  ComputerUseApprovalAction,
  DesktopComputerUseState,
} from "./computer-use-types";
import type {
  DesktopLocalAgentAddOptions,
  DesktopLocalAgentBackendProbe,
  DesktopLocalAgentEntry,
} from "./desktop-local-agent-types";

const desktopLocalAgentApi = {
  setEnabled(enabled: boolean): Promise<void> {
    return ipcRenderer.invoke(DESKTOP_LOCAL_AGENT_CHANNELS.setEnabled, enabled);
  },
  list(): Promise<DesktopLocalAgentEntry[]> {
    return ipcRenderer.invoke(DESKTOP_LOCAL_AGENT_CHANNELS.list);
  },
  detectBackends(): Promise<DesktopLocalAgentBackendProbe[]> {
    return ipcRenderer.invoke(DESKTOP_LOCAL_AGENT_CHANNELS.detectBackends);
  },
  add(
    options: DesktopLocalAgentAddOptions = {},
  ): Promise<DesktopLocalAgentEntry | null> {
    return ipcRenderer.invoke(DESKTOP_LOCAL_AGENT_CHANNELS.add, options);
  },
  start(id: string): Promise<DesktopLocalAgentEntry> {
    return ipcRenderer.invoke(DESKTOP_LOCAL_AGENT_CHANNELS.start, id);
  },
  stop(id: string): Promise<DesktopLocalAgentEntry> {
    return ipcRenderer.invoke(DESKTOP_LOCAL_AGENT_CHANNELS.stop, id);
  },
  remove(id: string): Promise<void> {
    return ipcRenderer.invoke(DESKTOP_LOCAL_AGENT_CHANNELS.remove, id);
  },
  openFolder(id: string): Promise<void> {
    return ipcRenderer.invoke(DESKTOP_LOCAL_AGENT_CHANNELS.openFolder, id);
  },
  subscribe(callback: () => void): () => void {
    const listener = (): void => {
      callback();
    };
    ipcRenderer.on(DESKTOP_LOCAL_AGENT_CHANNELS.changed, listener);
    return () => {
      ipcRenderer.off(DESKTOP_LOCAL_AGENT_CHANNELS.changed, listener);
    };
  },
};

const desktopComputerUseApi = {
  getState(): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(COMPUTER_USE_CHANNELS.getState);
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

contextBridge.exposeInMainWorld("vm0DesktopLocalAgent", desktopLocalAgentApi);
contextBridge.exposeInMainWorld("vm0DesktopComputerUse", desktopComputerUseApi);
