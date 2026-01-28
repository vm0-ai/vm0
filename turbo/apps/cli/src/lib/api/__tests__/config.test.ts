import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "fs";
import { readFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getApiUrl, saveConfig, getToken, clearConfig } from "../config";

// Create unique temp directory for this test file
const TEST_HOME = join(tmpdir(), `vm0-config-test-${process.pid}`);
const CONFIG_DIR = join(TEST_HOME, ".vm0");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// Mock homedir before importing config module
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => TEST_HOME,
  };
});

describe("config", () => {
  beforeEach(async () => {
    // Ensure clean state
    await rm(CONFIG_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(CONFIG_DIR, { recursive: true, force: true });
  });

  describe("getApiUrl", () => {
    it("should return VM0_API_URL from environment when set with http protocol", async () => {
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");
      const apiUrl = await getApiUrl();
      expect(apiUrl).toBe("http://localhost:3000");
    });

    it("should return VM0_API_URL from environment when set with https protocol", async () => {
      vi.stubEnv("VM0_API_URL", "https://api.example.com");
      const apiUrl = await getApiUrl();
      expect(apiUrl).toBe("https://api.example.com");
    });

    it("should add https protocol when VM0_API_URL lacks protocol", async () => {
      vi.stubEnv("VM0_API_URL", "api.example.com");
      const apiUrl = await getApiUrl();
      expect(apiUrl).toBe("https://api.example.com");
    });

    it("should return production URL when VM0_API_URL is not set and no config", async () => {
      const apiUrl = await getApiUrl();
      expect(apiUrl).toBe("https://www.vm0.ai");
    });

    it("should return config apiUrl when VM0_API_URL is not set but config exists", async () => {
      await mkdir(CONFIG_DIR, { recursive: true });
      await saveConfig({ apiUrl: "https://custom.example.com" });
      const apiUrl = await getApiUrl();
      expect(apiUrl).toBe("https://custom.example.com");
    });

    it("should prefer VM0_API_URL environment variable over config file", async () => {
      await mkdir(CONFIG_DIR, { recursive: true });
      await saveConfig({ apiUrl: "https://config.example.com" });
      vi.stubEnv("VM0_API_URL", "https://env.example.com");
      const apiUrl = await getApiUrl();
      expect(apiUrl).toBe("https://env.example.com");
    });

    it("should not read from API_HOST environment variable", async () => {
      // Set API_HOST (old variable) - should be ignored
      vi.stubEnv("API_HOST", "https://old-api.example.com");
      const apiUrl = await getApiUrl();
      // Should fallback to production URL, not use API_HOST
      expect(apiUrl).toBe("https://www.vm0.ai");
      expect(apiUrl).not.toBe("https://old-api.example.com");
    });
  });

  describe("getToken", () => {
    it("should return token from VM0_TOKEN environment variable when set", async () => {
      vi.stubEnv("VM0_TOKEN", "env-token-123");
      const token = await getToken();
      expect(token).toBe("env-token-123");
    });

    it("should return token from config file when VM0_TOKEN not set", async () => {
      await mkdir(CONFIG_DIR, { recursive: true });
      await saveConfig({ token: "config-token-456" });
      const token = await getToken();
      expect(token).toBe("config-token-456");
    });

    it("should prefer VM0_TOKEN environment variable over config file", async () => {
      await mkdir(CONFIG_DIR, { recursive: true });
      await saveConfig({ token: "config-token" });
      vi.stubEnv("VM0_TOKEN", "env-token");
      const token = await getToken();
      expect(token).toBe("env-token");
    });

    it("should return undefined when no token is set", async () => {
      const token = await getToken();
      expect(token).toBeUndefined();
    });
  });

  describe("saveConfig", () => {
    it("should create config directory if it does not exist", async () => {
      await saveConfig({ token: "test-token" });
      expect(existsSync(CONFIG_DIR)).toBe(true);
      expect(existsSync(CONFIG_FILE)).toBe(true);
    });

    it("should save token to config file", async () => {
      await saveConfig({ token: "test-token-789" });
      const content = await readFile(CONFIG_FILE, "utf8");
      const config = JSON.parse(content);
      expect(config.token).toBe("test-token-789");
    });

    it("should save apiUrl to config file", async () => {
      await saveConfig({ apiUrl: "https://test.example.com" });
      const content = await readFile(CONFIG_FILE, "utf8");
      const config = JSON.parse(content);
      expect(config.apiUrl).toBe("https://test.example.com");
    });

    it("should merge with existing config", async () => {
      await saveConfig({ token: "initial-token" });
      await saveConfig({ apiUrl: "https://test.example.com" });
      const content = await readFile(CONFIG_FILE, "utf8");
      const config = JSON.parse(content);
      expect(config.token).toBe("initial-token");
      expect(config.apiUrl).toBe("https://test.example.com");
    });

    it("should overwrite existing keys", async () => {
      await saveConfig({ token: "old-token" });
      await saveConfig({ token: "new-token" });
      const content = await readFile(CONFIG_FILE, "utf8");
      const config = JSON.parse(content);
      expect(config.token).toBe("new-token");
    });
  });

  describe("clearConfig", () => {
    it("should remove config file if it exists", async () => {
      await saveConfig({ token: "test-token" });
      expect(existsSync(CONFIG_FILE)).toBe(true);
      await clearConfig();
      expect(existsSync(CONFIG_FILE)).toBe(false);
    });

    it("should not throw error if config file does not exist", async () => {
      expect(existsSync(CONFIG_FILE)).toBe(false);
      await expect(clearConfig()).resolves.not.toThrow();
    });
  });
});
