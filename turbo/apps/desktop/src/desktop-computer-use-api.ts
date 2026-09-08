import { COMPUTER_USE_PLUGIN_CALL_KIND } from "@okouai/api-contracts/contracts/computer-use-plugins";
import type {
  ComputerUseCommand,
  ComputerUseCommandExecutionResult,
} from "./computer-use-accessibility";
import type { ComputerUseDriverController } from "./computer-use-driver";
import { ComputerUseHostRuntime } from "./computer-use-host";
import type { DesktopAuthSession } from "./desktop-auth-session";

export function createDesktopComputerUseHostRuntime(
  options: Omit<
    ConstructorParameters<typeof ComputerUseHostRuntime>[0],
    "sessionFetch" | "acquireCommand"
  > & {
    readonly driver: ComputerUseDriverController;
    readonly executePluginCommand: (
      command: ComputerUseCommand,
    ) => Promise<ComputerUseCommandExecutionResult>;
  },
  auth: {
    readonly getAuthSession: () => DesktopAuthSession;
  },
): ComputerUseHostRuntime {
  return new ComputerUseHostRuntime({
    ...options,
    acquireCommand: () => {
      // Pin before claim whenever native commands are advertised. Plugin-only
      // polling remains independent of native startup, permissions and cleanup.
      const native =
        options.driver.getCapabilities().length > 0
          ? options.driver.acquireCommand()
          : null;
      return {
        identity: native?.identity,
        beginCommand: (budget) => native?.beginCommand?.(budget),
        release: () => native?.release(),
        abort: () => native?.abort?.(),
        getPermissions: (command) =>
          command?.kind === COMPUTER_USE_PLUGIN_CALL_KIND || !native
            ? Promise.resolve({ accessibility: false, screenRecording: false })
            : native.getPermissions(command),
        executeCommand: (command, permissions) =>
          command.kind === COMPUTER_USE_PLUGIN_CALL_KIND
            ? options.executePluginCommand(command)
            : native
              ? native.executeCommand(command, permissions)
              : Promise.resolve({
                  status: "failed",
                  error: {
                    code: "accessibility_unavailable",
                    message:
                      "Native capabilities were withdrawn before claim; no action was dispatched",
                  },
                }),
      };
    },
    // Share the App session's bearer, refresh and sign-out lifetime.
    sessionFetch: (input, init) =>
      auth.getAuthSession().fetchWithSessionAuth(new URL(input), init),
  });
}
