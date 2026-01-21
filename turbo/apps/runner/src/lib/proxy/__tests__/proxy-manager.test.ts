import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { ProxyManager } from "../proxy-manager";

// Mock child_process only
vi.mock("child_process");

describe("ProxyManager", () => {
  let proxyManager: ProxyManager;
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-proxy-manager-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);

    // Use tempDir for caDir
    proxyManager = new ProxyManager({
      caDir: path.join(tempDir, "proxy"),
      port: 8080,
      apiUrl: "https://test.api.com",
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should use provided caDir and derive addonPath", () => {
      const config = proxyManager.getConfig();

      expect(config.caDir).toBe(path.join(tempDir, "proxy"));
      expect(config.addonPath).toBe(
        path.join(tempDir, "proxy", "mitm_addon.py"),
      );
    });

    it("should merge custom config with defaults", () => {
      const customDir = path.join(tempDir, "custom", "proxy");
      const customManager = new ProxyManager({
        caDir: customDir,
        port: 9090,
        apiUrl: "https://custom.api.com",
      });

      const config = customManager.getConfig();

      expect(config.port).toBe(9090);
      expect(config.apiUrl).toBe("https://custom.api.com");
      expect(config.caDir).toBe(customDir);
      expect(config.addonPath).toBe(path.join(customDir, "mitm_addon.py"));
    });

    it("should use default port when not specified", () => {
      const minimalDir = path.join(tempDir, "minimal", "proxy");
      const minimalManager = new ProxyManager({
        caDir: minimalDir,
      });

      const config = minimalManager.getConfig();

      expect(config.port).toBe(8080);
      expect(config.caDir).toBe(minimalDir);
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
      const caDir = path.join(tempDir, "proxy");
      const addonPath = path.join(caDir, "mitm_addon.py");

      // Ensure directory doesn't exist
      expect(fs.existsSync(caDir)).toBe(false);

      proxyManager.ensureAddonScript();

      // Verify directory was created
      expect(fs.existsSync(caDir)).toBe(true);
      // Verify addon script was written
      expect(fs.existsSync(addonPath)).toBe(true);
      // Verify file content
      const content = fs.readFileSync(addonPath, "utf-8");
      expect(content).toContain("def request");
    });

    it("should not create directory if it exists", () => {
      const caDir = path.join(tempDir, "proxy");
      const addonPath = path.join(caDir, "mitm_addon.py");

      // Create directory first
      fs.mkdirSync(caDir, { recursive: true });

      proxyManager.ensureAddonScript();

      // Verify addon script was still written
      expect(fs.existsSync(addonPath)).toBe(true);
    });
  });

  describe("validateConfig", () => {
    it("should throw error if CA directory does not exist", () => {
      // Directory doesn't exist yet
      expect(() => proxyManager.validateConfig()).toThrow(
        "Proxy CA directory not found",
      );
    });

    it("should throw error if CA certificate does not exist", () => {
      // Create directory but not the certificate
      fs.mkdirSync(path.join(tempDir, "proxy"), { recursive: true });

      expect(() => proxyManager.validateConfig()).toThrow(
        "Proxy CA certificate not found",
      );
    });

    it("should pass validation and write addon script when CA exists", () => {
      const caDir = path.join(tempDir, "proxy");
      const caCertPath = path.join(caDir, "mitmproxy-ca.pem");
      const addonPath = path.join(caDir, "mitm_addon.py");

      // Create directory and CA certificate
      fs.mkdirSync(caDir, { recursive: true });
      fs.writeFileSync(caCertPath, "fake cert content");

      proxyManager.validateConfig();

      // Should write addon script as part of validation
      expect(fs.existsSync(addonPath)).toBe(true);
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
