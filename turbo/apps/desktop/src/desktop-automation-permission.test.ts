import type { MessageBoxOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import type {
  ComputerUseCommand,
  ComputerUseCommandFailure,
} from "./computer-use-accessibility";
import {
  MAC_AUTOMATION_SETTINGS_URL,
  buildAutomationPermissionDialogOptions,
  createAutomationPermissionDeniedPrompt,
} from "./desktop-automation-permission";

const automationFailure: ComputerUseCommandFailure = {
  status: "failed",
  error: {
    code: "automation_permission_denied",
    message: "Not authorized to send Apple events to Google Chrome. (-1743)",
  },
};

function command(app: string): ComputerUseCommand {
  return {
    id: "cmd-1",
    kind: "element.set_value",
    payload: {
      app,
      value: "https://example.com",
    },
  };
}

describe("desktop automation permission prompt", () => {
  it("builds a dialog that opens the macOS Automation settings pane", () => {
    const options = buildAutomationPermissionDialogOptions(
      "Zero Computer Use",
      "Google Chrome",
    );

    expect(options).toMatchObject({
      type: "warning",
      buttons: ["Open Automation Settings", "Not Now"],
      defaultId: 0,
      cancelId: 1,
      title: "Browser Automation Permission Required",
      message: "Allow Zero Computer Use to control Google Chrome",
    });
    expect(options.detail).toContain(
      "System Settings > Privacy & Security > Automation",
    );
    expect(MAC_AUTOMATION_SETTINGS_URL).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
    );
  });

  it("opens Automation settings when the user accepts the prompt", async () => {
    const showDialog = vi.fn<(options: MessageBoxOptions) => Promise<number>>(
      async () => 0,
    );
    const openAutomationSettings = vi.fn<() => void>();
    const prompt = createAutomationPermissionDeniedPrompt({
      sourceLabel: "Zero Computer Use",
      showDialog,
      openAutomationSettings,
    });

    prompt({
      command: command("com.google.Chrome"),
      failure: automationFailure,
    });
    await vi.waitFor(() => {
      expect(openAutomationSettings).toHaveBeenCalledOnce();
    });

    expect(showDialog).toHaveBeenCalledOnce();
    expect(showDialog.mock.calls[0]?.[0].message).toBe(
      "Allow Zero Computer Use to control Google Chrome",
    );
  });

  it("does not prompt more than once per target app", async () => {
    const showDialog = vi.fn<(options: MessageBoxOptions) => Promise<number>>(
      async () => 1,
    );
    const openAutomationSettings = vi.fn<() => void>();
    const prompt = createAutomationPermissionDeniedPrompt({
      sourceLabel: "Zero Computer Use",
      showDialog,
      openAutomationSettings,
    });
    const chromeCommand = command("com.google.Chrome");

    prompt({ command: chromeCommand, failure: automationFailure });
    prompt({ command: chromeCommand, failure: automationFailure });

    await vi.waitFor(() => {
      expect(showDialog).toHaveBeenCalledOnce();
    });
    expect(openAutomationSettings).not.toHaveBeenCalled();
  });

  it("ignores unrelated command failures", () => {
    const showDialog = vi.fn<(options: MessageBoxOptions) => Promise<number>>(
      async () => 0,
    );
    const openAutomationSettings = vi.fn<() => void>();
    const prompt = createAutomationPermissionDeniedPrompt({
      sourceLabel: "Zero Computer Use",
      showDialog,
      openAutomationSettings,
    });
    const failure: ComputerUseCommandFailure = {
      status: "failed",
      error: {
        code: "screen_recording_unavailable",
        message: "macOS Screen Recording permission is required",
      },
    };

    prompt({ command: command("com.google.Chrome"), failure });

    expect(showDialog).not.toHaveBeenCalled();
    expect(openAutomationSettings).not.toHaveBeenCalled();
  });
});
