import { describe, expect, it, vi } from "vitest";
import type { DesktopAuthCallback } from "./desktop-auth";
import { startDesktopLaunchComputerUse } from "./desktop-launch-computer-use";

const pendingCallback: DesktopAuthCallback = {
  code: "a".repeat(32),
  handoffId: "11111111-1111-1111-1111-111111111111",
};

async function flushLaunchHandlers(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

function launchOptions(
  overrides: {
    readonly pendingCallback?: DesktopAuthCallback | null;
    readonly consumeAuthCallback?: (
      callback: DesktopAuthCallback,
    ) => Promise<void>;
    readonly isComputerUseSetupRequired?: () => Promise<boolean>;
    readonly openSetupWindow?: () => Promise<void>;
    readonly requestAutoStartComputerUse?: () => void;
    readonly logAuthError?: (error: unknown) => void;
    readonly logLaunchError?: (error: unknown) => void;
  } = {},
) {
  return {
    pendingCallback: null,
    consumeAuthCallback: vi.fn(async () => {}),
    isComputerUseSetupRequired: vi.fn(async () => false),
    openSetupWindow: vi.fn(async () => {}),
    requestAutoStartComputerUse: vi.fn(),
    logAuthError: vi.fn(),
    logLaunchError: vi.fn(),
    ...overrides,
  };
}

describe("startDesktopLaunchComputerUse", () => {
  it("auto-starts Computer Use when setup is ready", async () => {
    const options = launchOptions();

    startDesktopLaunchComputerUse(options);
    await flushLaunchHandlers();

    expect(options.isComputerUseSetupRequired).toHaveBeenCalledOnce();
    expect(options.requestAutoStartComputerUse).toHaveBeenCalledOnce();
    expect(options.openSetupWindow).not.toHaveBeenCalled();
    expect(options.consumeAuthCallback).not.toHaveBeenCalled();
  });

  it("opens the setup window instead of auto-starting when setup is required", async () => {
    const options = launchOptions({
      isComputerUseSetupRequired: vi.fn(async () => true),
    });

    startDesktopLaunchComputerUse(options);
    await flushLaunchHandlers();

    expect(options.openSetupWindow).toHaveBeenCalledOnce();
    expect(options.requestAutoStartComputerUse).not.toHaveBeenCalled();
    expect(options.consumeAuthCallback).not.toHaveBeenCalled();
  });

  it("consumes the pending auth callback instead of auto-starting", async () => {
    const options = launchOptions({ pendingCallback });

    startDesktopLaunchComputerUse(options);
    await flushLaunchHandlers();

    expect(options.consumeAuthCallback).toHaveBeenCalledWith(pendingCallback);
    expect(options.isComputerUseSetupRequired).not.toHaveBeenCalled();
    expect(options.openSetupWindow).not.toHaveBeenCalled();
    expect(options.requestAutoStartComputerUse).not.toHaveBeenCalled();
    expect(options.logAuthError).not.toHaveBeenCalled();
  });

  it("logs auth callback failures from the background launch task", async () => {
    const error = new Error("consume failed");
    const options = launchOptions({
      pendingCallback,
      consumeAuthCallback: vi.fn(async () => {
        throw error;
      }),
    });

    startDesktopLaunchComputerUse(options);
    await flushLaunchHandlers();

    expect(options.logAuthError).toHaveBeenCalledWith(error);
  });

  it("logs setup check failures and falls back to auto-start", async () => {
    const error = new Error("setup check failed");
    const options = launchOptions({
      isComputerUseSetupRequired: vi.fn(async () => {
        throw error;
      }),
    });

    startDesktopLaunchComputerUse(options);
    await flushLaunchHandlers();

    expect(options.logLaunchError).toHaveBeenCalledWith(error);
    expect(options.requestAutoStartComputerUse).toHaveBeenCalledOnce();
  });
});
