import type { IpcMainInvokeEvent } from "electron";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { DESKTOP_LOCAL_AGENT_CHANNELS } from "./desktop-local-agent-ipc-channels";
import type { DesktopLocalAgentManager } from "./desktop-local-agent-manager";
import type { DesktopLocalAgentAddOptions } from "./desktop-local-agent-types";

function stringArg(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Expected local agent id");
  }
  return value;
}

function addOptionsArg(value: unknown): DesktopLocalAgentAddOptions {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const options = value as DesktopLocalAgentAddOptions;
  return {
    ...(options.backend ? { backend: options.backend } : {}),
    ...(options.permissionMode
      ? { permissionMode: options.permissionMode }
      : {}),
  };
}

export function notifyDesktopLocalAgentsChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(DESKTOP_LOCAL_AGENT_CHANNELS.changed);
    }
  }
}

export function installDesktopLocalAgentIpc(
  manager: DesktopLocalAgentManager,
): void {
  ipcMain.handle(
    DESKTOP_LOCAL_AGENT_CHANNELS.setEnabled,
    async (_event: IpcMainInvokeEvent, enabled: unknown) => {
      await manager.setEnabled(enabled === true);
    },
  );
  ipcMain.handle(DESKTOP_LOCAL_AGENT_CHANNELS.list, async () => {
    return manager.list();
  });
  ipcMain.handle(DESKTOP_LOCAL_AGENT_CHANNELS.detectBackends, async () => {
    return manager.detectBackends();
  });
  ipcMain.handle(
    DESKTOP_LOCAL_AGENT_CHANNELS.add,
    async (_event: IpcMainInvokeEvent, options: unknown) => {
      return manager.add(addOptionsArg(options));
    },
  );
  ipcMain.handle(
    DESKTOP_LOCAL_AGENT_CHANNELS.start,
    async (_event: IpcMainInvokeEvent, id: unknown) => {
      return manager.start(stringArg(id));
    },
  );
  ipcMain.handle(
    DESKTOP_LOCAL_AGENT_CHANNELS.stop,
    async (_event: IpcMainInvokeEvent, id: unknown) => {
      return manager.stop(stringArg(id));
    },
  );
  ipcMain.handle(
    DESKTOP_LOCAL_AGENT_CHANNELS.remove,
    async (_event: IpcMainInvokeEvent, id: unknown) => {
      await manager.remove(stringArg(id));
    },
  );
  ipcMain.handle(
    DESKTOP_LOCAL_AGENT_CHANNELS.openFolder,
    async (_event: IpcMainInvokeEvent, id: unknown) => {
      await manager.openFolder(stringArg(id));
    },
  );
}

export async function selectLocalAgentFolder(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Add local agent",
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

export async function openLocalAgentFolder(folderPath: string): Promise<void> {
  const error = await shell.openPath(folderPath);
  if (error.length > 0) {
    throw new Error(error);
  }
}
