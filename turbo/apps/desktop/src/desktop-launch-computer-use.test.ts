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
    readonly requestAutoStartComputerUse?: () => void;
    readonly logAuthError?: (error: unknown) => void;
  } = {},
) {
  return {
    pendingCallback: null,
    consumeAuthCallback: vi.fn(async () => {}),
    requestAutoStartComputerUse: vi.fn(),
    logAuthError: vi.fn(),
    ...overrides,
  };
}

describe("startDesktopLaunchComputerUse", () => {
  it("auto-starts Computer Use when launch has no pending auth callback", async () => {
    const options = launchOptions();

    startDesktopLaunchComputerUse(options);
    await flushLaunchHandlers();

    expect(options.requestAutoStartComputerUse).toHaveBeenCalledOnce();
    expect(options.consumeAuthCallback).not.toHaveBeenCalled();
  });

  it("consumes the pending auth callback instead of auto-starting", async () => {
    const options = launchOptions({ pendingCallback });

    startDesktopLaunchComputerUse(options);
    await flushLaunchHandlers();

    expect(options.consumeAuthCallback).toHaveBeenCalledWith(pendingCallback);
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
});
