import type { MessageBoxOptions } from "electron";
import type {
  ComputerUseCommand,
  ComputerUseCommandFailure,
} from "./computer-use-accessibility";

export const MAC_AUTOMATION_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

interface AutomationPermissionTarget {
  readonly key: string;
  readonly label: string;
}

interface AutomationPermissionPromptOptions {
  readonly sourceLabel: string;
  readonly showDialog: (options: MessageBoxOptions) => Promise<number>;
  readonly openAutomationSettings: () => void;
  readonly onError?: (error: unknown) => void;
}

interface AutomationPermissionDeniedNotification {
  readonly command: ComputerUseCommand;
  readonly failure: ComputerUseCommandFailure;
}

const AUTOMATION_TARGET_LABELS = Object.freeze<Record<string, string>>({
  "com.apple.safari": "Safari",
  "com.google.chrome": "Google Chrome",
});

function commandApp(command: ComputerUseCommand): string | null {
  const value = command.payload.app;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function automationPermissionTarget(
  command: ComputerUseCommand,
): AutomationPermissionTarget {
  const app = commandApp(command);
  if (!app) {
    return { key: "target-app", label: "the target app" };
  }

  const key = app.toLowerCase();
  return {
    key,
    label: AUTOMATION_TARGET_LABELS[key] ?? app,
  };
}

export function buildAutomationPermissionDialogOptions(
  sourceLabel: string,
  targetLabel: string,
): MessageBoxOptions {
  return {
    type: "warning",
    buttons: ["Open Automation Settings", "Not Now"],
    defaultId: 0,
    cancelId: 1,
    title: "Browser Automation Permission Required",
    message: `Allow ${sourceLabel} to control ${targetLabel}`,
    detail:
      "Open System Settings > Privacy & Security > Automation and allow " +
      `${sourceLabel} to control ${targetLabel}.`,
  };
}

export function createAutomationPermissionDeniedPrompt(
  options: AutomationPermissionPromptOptions,
): (notification: AutomationPermissionDeniedNotification) => void {
  const promptedTargets = new Set<string>();

  return ({ command, failure }) => {
    if (failure.error.code !== "automation_permission_denied") {
      return;
    }

    const target = automationPermissionTarget(command);
    if (promptedTargets.has(target.key)) {
      return;
    }
    promptedTargets.add(target.key);

    void options
      .showDialog(
        buildAutomationPermissionDialogOptions(
          options.sourceLabel,
          target.label,
        ),
      )
      .then((response) => {
        if (response === 0) {
          options.openAutomationSettings();
        }
      })
      .catch((error: unknown) => {
        options.onError?.(error);
      });
  };
}
