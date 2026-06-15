import type { DesktopAuthCallback } from "./desktop-auth";

interface DesktopLaunchComputerUseOptions {
  readonly pendingCallback: DesktopAuthCallback | null;
  readonly consumeAuthCallback: (
    callback: DesktopAuthCallback,
  ) => Promise<void>;
  readonly requestAutoStartComputerUse: () => void;
  readonly logAuthError: (error: unknown) => void;
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

  options.requestAutoStartComputerUse();
}
