import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { cleanupEnvironment } from "../setup.js";
import type { RunnerResources } from "../types.js";

// Mock dependencies
vi.mock("../../firecracker/network.js", () => ({
  cleanupCIDRProxyRules: vi.fn(),
}));

vi.mock("../../proxy/index.js", () => ({
  getProxyManager: vi.fn(() => ({
    stop: vi.fn(),
  })),
}));

vi.mock("../runner-lock.js", () => ({
  releaseRunnerLock: vi.fn(),
}));

vi.mock("../../logger.js", () => ({
  createLogger: vi.fn(() => ({
    log: vi.fn(),
    error: vi.fn(),
  })),
}));

import { cleanupCIDRProxyRules } from "../../firecracker/network.js";
import { getProxyManager } from "../../proxy/index.js";
import { releaseRunnerLock } from "../runner-lock.js";

describe("cleanupEnvironment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should execute all cleanup steps when proxy is enabled", async () => {
    const resources: RunnerResources = {
      proxyEnabled: true,
      proxyPort: 8080,
    };

    await cleanupEnvironment(resources);

    expect(cleanupCIDRProxyRules).toHaveBeenCalledWith(8080);
    expect(getProxyManager).toHaveBeenCalled();
    expect(releaseRunnerLock).toHaveBeenCalled();
  });

  it("should skip proxy cleanup when proxy is disabled", async () => {
    const resources: RunnerResources = {
      proxyEnabled: false,
      proxyPort: 8080,
    };

    await cleanupEnvironment(resources);

    expect(cleanupCIDRProxyRules).not.toHaveBeenCalled();
    expect(getProxyManager).not.toHaveBeenCalled();
    expect(releaseRunnerLock).toHaveBeenCalled();
  });

  it("should continue cleanup if CIDR rules cleanup fails", async () => {
    const resources: RunnerResources = {
      proxyEnabled: true,
      proxyPort: 8080,
    };

    (cleanupCIDRProxyRules as Mock).mockRejectedValueOnce(
      new Error("iptables error"),
    );

    await cleanupEnvironment(resources);

    // Should still call subsequent cleanup steps
    expect(getProxyManager).toHaveBeenCalled();
    expect(releaseRunnerLock).toHaveBeenCalled();
  });

  it("should continue cleanup if proxy stop fails", async () => {
    const resources: RunnerResources = {
      proxyEnabled: true,
      proxyPort: 8080,
    };

    const mockStop = vi.fn().mockRejectedValueOnce(new Error("proxy error"));
    (getProxyManager as Mock).mockReturnValue({ stop: mockStop });

    await cleanupEnvironment(resources);

    // Should still release runner lock
    expect(releaseRunnerLock).toHaveBeenCalled();
  });

  it("should continue cleanup if runner lock release fails", async () => {
    const resources: RunnerResources = {
      proxyEnabled: true,
      proxyPort: 8080,
    };

    (releaseRunnerLock as Mock).mockImplementationOnce(() => {
      throw new Error("lock error");
    });

    // Should not throw
    await expect(cleanupEnvironment(resources)).resolves.toBeUndefined();
  });

  it("should handle multiple failures without throwing", async () => {
    const resources: RunnerResources = {
      proxyEnabled: true,
      proxyPort: 8080,
    };

    (cleanupCIDRProxyRules as Mock).mockRejectedValueOnce(
      new Error("iptables error"),
    );
    const mockStop = vi.fn().mockRejectedValueOnce(new Error("proxy error"));
    (getProxyManager as Mock).mockReturnValue({ stop: mockStop });
    (releaseRunnerLock as Mock).mockImplementationOnce(() => {
      throw new Error("lock error");
    });

    // Should not throw even with all steps failing
    await expect(cleanupEnvironment(resources)).resolves.toBeUndefined();
  });
});
