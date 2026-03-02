/**
 * Tests for org token auto-refresh behavior
 *
 * Tests that getActiveToken() transparently refreshes expired org tokens
 * by calling /api/scope/use with the user's base token.
 *
 * Uses real filesystem (temp dir) for config and MSW for the refresh API call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { getActiveToken } from "../config";

describe("org token auto-refresh", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "test-cli-config-"));
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    // VM0_TOKEN is already cleared to "" by global setup, so getActiveToken()
    // will read from the config file instead of the env var.
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

  it("should refresh expired org token and return new token", async () => {
    writeConfig({
      token: "vm0_live_user-token",
      orgToken: "vm0_org_expired",
      orgTokenExpiresAt: new Date(Date.now() - 3600000).toISOString(),
      activeScope: "my-org",
    });

    server.use(
      http.post("http://localhost:3000/api/scope/use", () => {
        return HttpResponse.json({
          scope: { slug: "my-org", type: "organization" },
          token: "vm0_org_refreshed",
          expiresAt: new Date(Date.now() + 7200000).toISOString(),
        });
      }),
    );

    const token = await getActiveToken();
    expect(token).toBe("vm0_org_refreshed");
  });

  it("should fall back to user token when refresh fails", async () => {
    writeConfig({
      token: "vm0_live_user-token",
      orgToken: "vm0_org_expired",
      orgTokenExpiresAt: new Date(Date.now() - 3600000).toISOString(),
      activeScope: "my-org",
    });

    server.use(
      http.post("http://localhost:3000/api/scope/use", () => {
        return HttpResponse.json(
          { error: { message: "Scope not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
    );

    const token = await getActiveToken();
    expect(token).toBe("vm0_live_user-token");
  });

  it("should return valid org token without refresh", async () => {
    writeConfig({
      token: "vm0_live_user-token",
      orgToken: "vm0_org_valid",
      orgTokenExpiresAt: new Date(Date.now() + 7200000).toISOString(),
      activeScope: "my-org",
    });

    const token = await getActiveToken();
    expect(token).toBe("vm0_org_valid");
  });

  it("should return user token when no org token configured", async () => {
    writeConfig({
      token: "vm0_live_user-token",
    });

    const token = await getActiveToken();
    expect(token).toBe("vm0_live_user-token");
  });
});
