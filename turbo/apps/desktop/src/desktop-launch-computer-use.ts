import type { DesktopAuthCallback } from "./desktop-auth";

interface DesktopLaunchComputerUseOptions {
  readonly pendingCallback: DesktopAuthCallback | null;
  readonly consumeAuthCallback: (
    callback: DesktopAuthCallback,
  ) => Promise<void>;
  readonly isComputerUseSetupRequired: () => Promise<boolean>;
  readonly openSetupWindow: () => Promise<void>;
  readonly requestAutoStartComputerUse: () => void;
  readonly logAuthError: (error: unknown) => void;
  readonly logLaunchError: (error: unknown) => void;
}

async function launchComputerUseWithoutAuthCallback(
  options: DesktopLaunchComputerUseOptions,
): Promise<void> {
  if (await options.isComputerUseSetupRequired()) {
    await options.openSetupWindow();
    return;
  }

  options.requestAutoStartComputerUse();
}

export function startDesktopLaunchComputerUse(
  options: DesktopLaunchComputerUseOptions,
): void {
  if (options.pendingCallback) {
    void options
      .consumeAuthCallback(options.pendingCallback)
      .catch(options.logAuthError);
    return;
  }

  void launchComputerUseWithoutAuthCallback(options).catch((error) => {
    options.logLaunchError(error);
    options.requestAutoStartComputerUse();
  });
}
