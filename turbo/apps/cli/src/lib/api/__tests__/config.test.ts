import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// Mock os.homedir to use temp directory for config isolation
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-config-home-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => TEST_HOME,
  };
});

import { getToken, getActiveToken } from "../config";

describe("token resolution", () => {
  beforeEach(async () => {
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  async function writeConfigToken(token: string): Promise<void> {
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ token }),
    );
  }

  describe("getActiveToken", () => {
    it("should return ZERO_TOKEN when set", async () => {
      vi.stubEnv("ZERO_TOKEN", "zero-token-value");

      const token = await getActiveToken();
      expect(token).toBe("zero-token-value");
    });

    it("should fall back to VM0_TOKEN when ZERO_TOKEN is not set", async () => {
      vi.stubEnv("VM0_TOKEN", "vm0-token-value");

      const token = await getActiveToken();
      expect(token).toBe("vm0-token-value");
    });

    it("should fall back to config file when neither env var is set", async () => {
      await writeConfigToken("config-token-value");

      const token = await getActiveToken();
      expect(token).toBe("config-token-value");
    });

    it("should return ZERO_TOKEN over VM0_TOKEN when both are set", async () => {
      vi.stubEnv("ZERO_TOKEN", "zero-wins");
      vi.stubEnv("VM0_TOKEN", "vm0-loses");

      const token = await getActiveToken();
      expect(token).toBe("zero-wins");
    });

    it("should return undefined when no token source is available", async () => {
      const token = await getActiveToken();
      expect(token).toBeUndefined();
    });
  });

  describe("getToken", () => {
    it("should return ZERO_TOKEN when set", async () => {
      vi.stubEnv("ZERO_TOKEN", "zero-token-value");

      const token = await getToken();
      expect(token).toBe("zero-token-value");
    });

    it("should fall back to VM0_TOKEN when ZERO_TOKEN is not set", async () => {
      vi.stubEnv("VM0_TOKEN", "vm0-token-value");

      const token = await getToken();
      expect(token).toBe("vm0-token-value");
    });

    it("should fall back to config file when neither env var is set", async () => {
      await writeConfigToken("config-token-value");

      const token = await getToken();
      expect(token).toBe("config-token-value");
    });

    it("should return ZERO_TOKEN over VM0_TOKEN when both are set", async () => {
      vi.stubEnv("ZERO_TOKEN", "zero-wins");
      vi.stubEnv("VM0_TOKEN", "vm0-loses");

      const token = await getToken();
      expect(token).toBe("zero-wins");
    });
  });
});
