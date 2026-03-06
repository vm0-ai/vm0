/**
 * Tests for getActiveToken() behavior
 *
 * Tests that getActiveToken() returns the correct token based on
 * VM0_TOKEN env var or config file.
 *
 * Uses real filesystem (temp dir) for config.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getActiveToken } from "../config";

describe("getActiveToken", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "test-cli-config-"));
    vi.stubEnv("HOME", tempDir);
    // Clear VM0_TOKEN so getActiveToken reads from config file
    vi.stubEnv("VM0_TOKEN", "");
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>): void {
    const configDir = join(tempDir, ".vm0");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify(config, null, 2),
    );
  }

  it("should return VM0_TOKEN env var when set", async () => {
    vi.stubEnv("VM0_TOKEN", "vm0_live_env-token");

    const token = await getActiveToken();
    expect(token).toBe("vm0_live_env-token");
  });

  it("should return token from config when VM0_TOKEN is empty", async () => {
    writeConfig({
      token: "vm0_live_config-token",
    });

    const token = await getActiveToken();
    expect(token).toBe("vm0_live_config-token");
  });

  it("should return undefined when no token available", async () => {
    writeConfig({});

    const token = await getActiveToken();
    expect(token).toBeUndefined();
  });

  it("should return undefined when config file does not exist", async () => {
    const token = await getActiveToken();
    expect(token).toBeUndefined();
  });
});
