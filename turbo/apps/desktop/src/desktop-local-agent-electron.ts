import type { IpcMainInvokeEvent } from "electron";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { DESKTOP_LOCAL_AGENT_CHANNELS } from "./desktop-local-agent-ipc-channels";
import type { DesktopLocalAgentManager } from "./desktop-local-agent-manager";
import { isDesktopLocalAgentPageUrl } from "./desktop-local-agent-page-url";
import type { DesktopLocalAgentAddOptions } from "./desktop-local-agent-types";

interface DesktopLocalAgentIpcOptions {
  readonly allowedAppOrigins: ReadonlySet<string>;
}

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
  options: DesktopLocalAgentIpcOptions,
): void {
  const assertLocalAgentPage = (event: IpcMainInvokeEvent): void => {
    if (
      !isDesktopLocalAgentPageUrl(
        event.senderFrame?.url ?? "",
        options.allowedAppOrigins,
      )
    ) {
      throw new Error("Desktop local agent is unavailable on this page");
    }
  };

  ipcMain.handle(
    DESKTOP_LOCAL_AGENT_CHANNELS.setEnabled,
    async (event: IpcMainInvokeEvent, enabled: unknown) => {
      assertLocalAgentPage(event);
      await manager.setEnabled(enabled === true);
    },
  );
  ipcMain.handle(DESKTOP_LOCAL_AGENT_CHANNELS.list, async (event) => {
    assertLocalAgentPage(event);
    return manager.list();
  });
  ipcMain.handle(DESKTOP_LOCAL_AGENT_CHANNELS.detectBackends, async (event) => {
    assertLocalAgentPage(event);
    return manager.detectBackends();
  });
  ipcMain.handle(
    DESKTOP_LOCAL_AGENT_CHANNELS.add,
    async (event: IpcMainInvokeEvent, addOptions: unknown) => {
      assertLocalAgentPage(event);
      return manager.add(addOptionsArg(addOptions));
    },
  );
  ipcMain.handle(
    DESKTOP_LOCAL_AGENT_CHANNELS.start,
    async (event: IpcMainInvokeEvent, id: unknown) => {
      assertLocalAgentPage(event);
      return manager.start(stringArg(id));
    },
  );
  ipcMain.handle(
    DESKTOP_LOCAL_AGENT_CHANNELS.stop,
    async (event: IpcMainInvokeEvent, id: unknown) => {
      assertLocalAgentPage(event);
      return manager.stop(stringArg(id));
    },
  );
  ipcMain.handle(
    DESKTOP_LOCAL_AGENT_CHANNELS.remove,
    async (event: IpcMainInvokeEvent, id: unknown) => {
      assertLocalAgentPage(event);
      await manager.remove(stringArg(id));
    },
  );
  ipcMain.handle(
    DESKTOP_LOCAL_AGENT_CHANNELS.openFolder,
    async (event: IpcMainInvokeEvent, id: unknown) => {
      assertLocalAgentPage(event);
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
