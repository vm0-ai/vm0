import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    app: {
      name: "Electron",
      getPath: vi.fn<(name: string) => string>(
        () => "/Users/test/Library/Application Support",
      ),
      setName: vi.fn<(name: string) => void>(),
      setPath: vi.fn<(name: string, path: string) => void>(),
      whenReady: vi.fn<() => Promise<void>>(() => new Promise(() => {})),
    },
    enterDegradedDesktopMode: vi.fn(),
  };
});

vi.mock("electron", () => ({ app: mocks.app }));

vi.mock("./config", () => ({
  resolveDesktopConfig: () => ({
    platformUrl: new URL("https://app.okou.ai"),
    webUrl: new URL("https://www.vm0.ai"),
    environment: "production",
    identity: {
      product: "okou",
      brandName: "Okou",
      displayName: "Okou",
      userDataDirectoryName: "Okou",
      updateLine: "ai-okou-desktop",
      bundleId: "ai.okou.desktop",
      authProtocolName: "Okou Auth",
      authScheme: "ai.okou.desktop",
    },
    sessionPartition: "persist:vm0-desktop-production",
    allowedAppOrigins: new Set(["https://app.okou.ai"]),
  }),
}));

vi.mock("./bootstrap-degraded", () => ({
  enterDegradedDesktopMode: mocks.enterDegradedDesktopMode,
}));

vi.mock("./desktop-api-base-url", () => ({
  resolveComputerUseApiBaseUrl: () => "https://api.vm0.ai",
}));

vi.mock("./desktop-auto-updates", () => ({
  installDesktopAutoUpdates: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  mocks.app.name = "Electron";
  mocks.app.getPath.mockClear();
  mocks.app.setName.mockClear();
  mocks.app.setPath.mockClear();
  mocks.enterDegradedDesktopMode.mockClear();
});

describe("desktop bootstrap identity", () => {
  it("selects the final Okou name and a fresh data directory before startup", async () => {
    await import("./bootstrap");

    expect(mocks.app.setName).toHaveBeenCalledExactlyOnceWith("Okou");
    expect(mocks.app.name).toBe("Okou");
    expect(mocks.app.getPath).toHaveBeenCalledExactlyOnceWith("appData");
    expect(mocks.app.setPath).toHaveBeenCalledExactlyOnceWith(
      "userData",
      "/Users/test/Library/Application Support/Okou",
    );
    expect(mocks.enterDegradedDesktopMode).toHaveBeenCalledOnce();
  });
});
