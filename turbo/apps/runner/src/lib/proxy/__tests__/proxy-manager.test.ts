import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import { spawn } from "child_process";
import { ProxyManager } from "../proxy-manager";

// Mock modules
vi.mock("fs");
vi.mock("child_process");

// Test configuration with required caDir
const TEST_CA_DIR = "/test/proxy";
const TEST_CONFIG = {
  caDir: TEST_CA_DIR,
  port: 8080,
  apiUrl: "https://test.api.com",
};

describe("ProxyManager", () => {
  let proxyManager: ProxyManager;

  beforeEach(() => {
    vi.clearAllMocks();
    proxyManager = new ProxyManager(TEST_CONFIG);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should use provided caDir and derive addonPath", () => {
      const config = proxyManager.getConfig();

      expect(config.caDir).toBe(TEST_CA_DIR);
      expect(config.addonPath).toBe(`${TEST_CA_DIR}/mitm_addon.py`);
    });

    it("should merge custom config with defaults", () => {
      const customManager = new ProxyManager({
        caDir: "/custom/proxy",
        port: 9090,
        apiUrl: "https://custom.api.com",
      });

      const config = customManager.getConfig();

      expect(config.port).toBe(9090);
      expect(config.apiUrl).toBe("https://custom.api.com");
      expect(config.caDir).toBe("/custom/proxy");
      expect(config.addonPath).toBe("/custom/proxy/mitm_addon.py");
    });

    it("should use default port when not specified", () => {
      const minimalManager = new ProxyManager({
        caDir: "/minimal/proxy",
      });

      const config = minimalManager.getConfig();

      expect(config.port).toBe(8080);
      expect(config.caDir).toBe("/minimal/proxy");
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

      expect(mockMkdirSync).toHaveBeenCalledWith(TEST_CA_DIR, {
        recursive: true,
      });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        `${TEST_CA_DIR}/mitm_addon.py`,
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
        if (path === TEST_CA_DIR) return true;
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
