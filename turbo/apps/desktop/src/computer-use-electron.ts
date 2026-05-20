import type { IpcMainInvokeEvent } from "electron";
import { BrowserWindow, ipcMain, shell } from "electron";
import { COMPUTER_USE_CHANNELS } from "./computer-use-ipc-channels";
import { isDesktopComputerUsePageUrl } from "./computer-use-page-url";
import type {
  ComputerUseApprovalAction,
  DesktopComputerUseState,
} from "./computer-use-types";

interface ComputerUseIpcOptions {
  readonly allowedAppOrigins: ReadonlySet<string>;
}

interface ComputerUseNativeApi {
  readonly getState: () => DesktopComputerUseState;
  readonly requestAccessibilityPermission: () => DesktopComputerUseState;
  readonly decideCommand: (
    action: ComputerUseApprovalAction,
  ) => Promise<DesktopComputerUseState>;
}

function approvalActionArg(value: unknown): ComputerUseApprovalAction {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected Computer Use approval action");
  }
  const action = value as Partial<ComputerUseApprovalAction>;
  if (
    typeof action.commandId !== "string" ||
    action.commandId.length === 0 ||
    (action.decision !== "approve" && action.decision !== "deny")
  ) {
    throw new Error("Expected Computer Use approval action");
  }
  return { commandId: action.commandId, decision: action.decision };
}

export function notifyDesktopComputerUseChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(COMPUTER_USE_CHANNELS.changed);
    }
  }
}

export function installComputerUseIpc(
  api: ComputerUseNativeApi,
  options: ComputerUseIpcOptions,
): void {
  const assertComputerUsePage = (event: IpcMainInvokeEvent): void => {
    if (
      !isDesktopComputerUsePageUrl(
        event.senderFrame?.url ?? "",
        options.allowedAppOrigins,
      )
    ) {
      throw new Error("Desktop Computer Use is unavailable on this page");
    }
  };

  ipcMain.handle(COMPUTER_USE_CHANNELS.getState, (event) => {
    assertComputerUsePage(event);
    return api.getState();
  });
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.requestAccessibilityPermission,
    (event) => {
      assertComputerUsePage(event);
      return api.requestAccessibilityPermission();
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.openAccessibilitySettings,
    async (event) => {
      assertComputerUsePage(event);
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.openScreenRecordingSettings,
    async (event) => {
      assertComputerUsePage(event);
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      );
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.decideCommand,
    async (event: IpcMainInvokeEvent, value: unknown) => {
      assertComputerUsePage(event);
      return api.decideCommand(approvalActionArg(value));
    },
  );
}
