import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import { spawn } from "child_process";
import { ProxyManager, DEFAULT_PROXY_CONFIG } from "../proxy-manager";

// Mock modules
vi.mock("fs");
vi.mock("child_process");
vi.mock("../vm-registry", () => ({
  getVMRegistry: vi.fn(() => ({
    register: vi.fn(),
    unregister: vi.fn(),
  })),
  DEFAULT_REGISTRY_PATH: "/tmp/vm0-vm-registry.json",
}));

describe("ProxyManager", () => {
  let proxyManager: ProxyManager;

  beforeEach(() => {
    vi.clearAllMocks();
    proxyManager = new ProxyManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should use default config when not specified", () => {
      const config = proxyManager.getConfig();

      expect(config.port).toBe(DEFAULT_PROXY_CONFIG.port);
      expect(config.caDir).toBe(DEFAULT_PROXY_CONFIG.caDir);
      expect(config.addonPath).toBe(DEFAULT_PROXY_CONFIG.addonPath);
    });

    it("should merge custom config with defaults", () => {
      const customManager = new ProxyManager({
        port: 9090,
        apiUrl: "https://custom.api.com",
      });

      const config = customManager.getConfig();

      expect(config.port).toBe(9090);
      expect(config.apiUrl).toBe("https://custom.api.com");
      expect(config.caDir).toBe(DEFAULT_PROXY_CONFIG.caDir); // Default value
    });
  });

  describe("checkMitmproxyInstalled", () => {
    it("should return true when mitmproxy is installed", async () => {
      const mockSpawn = vi.mocked(spawn);
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === "close") {
            setTimeout(() => callback(0), 0);
          }
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(
        mockProcess as unknown as ReturnType<typeof spawn>,
      );

      const result = await proxyManager.checkMitmproxyInstalled();

      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith(
        "mitmdump",
        ["--version"],
        expect.any(Object),
      );
    });

    it("should return false when mitmproxy is not installed", async () => {
      const mockSpawn = vi.mocked(spawn);
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === "error") {
            setTimeout(() => callback(new Error("not found")), 0);
          }
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(
        mockProcess as unknown as ReturnType<typeof spawn>,
      );

      const result = await proxyManager.checkMitmproxyInstalled();

      expect(result).toBe(false);
    });
  });

  describe("ensureAddonScript", () => {
    it("should create directory and write addon script", () => {
      const mockExistsSync = vi.mocked(fs.existsSync);
      const mockMkdirSync = vi.mocked(fs.mkdirSync);
      const mockWriteFileSync = vi.mocked(fs.writeFileSync);

      mockExistsSync.mockReturnValue(false);

      proxyManager.ensureAddonScript();

      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("proxy"),
        { recursive: true },
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        DEFAULT_PROXY_CONFIG.addonPath,
        expect.any(String),
        { mode: 0o755 },
      );
    });

    it("should not create directory if it exists", () => {
      const mockExistsSync = vi.mocked(fs.existsSync);
      const mockMkdirSync = vi.mocked(fs.mkdirSync);
      const mockWriteFileSync = vi.mocked(fs.writeFileSync);

      mockExistsSync.mockReturnValue(true);

      proxyManager.ensureAddonScript();

      expect(mockMkdirSync).not.toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });

  describe("validateConfig", () => {
    it("should throw error if CA directory does not exist", () => {
      const mockExistsSync = vi.mocked(fs.existsSync);
      mockExistsSync.mockReturnValue(false);

      expect(() => proxyManager.validateConfig()).toThrow(
        "Proxy CA directory not found",
      );
    });

    it("should throw error if CA certificate does not exist", () => {
      const mockExistsSync = vi.mocked(fs.existsSync);
      mockExistsSync.mockImplementation((path) => {
        if (path === DEFAULT_PROXY_CONFIG.caDir) return true;
        return false; // CA cert doesn't exist
      });

      expect(() => proxyManager.validateConfig()).toThrow(
        "Proxy CA certificate not found",
      );
    });

    it("should pass validation and write addon script when CA exists", () => {
      const mockExistsSync = vi.mocked(fs.existsSync);
      const mockWriteFileSync = vi.mocked(fs.writeFileSync);

      mockExistsSync.mockReturnValue(true);

      proxyManager.validateConfig();

      // Should write addon script as part of validation
      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });

  describe("isProxyRunning", () => {
    it("should return false when proxy is not started", () => {
      expect(proxyManager.isProxyRunning()).toBe(false);
    });
  });

  describe("getConfig", () => {
    it("should return a copy of the config", () => {
      const config1 = proxyManager.getConfig();
      const config2 = proxyManager.getConfig();

      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2); // Different object references
    });
  });
});
