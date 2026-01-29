import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { readFile } from "fs/promises";
import * as path from "path";
import * as os from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server.js";
import { isAuthenticated, runAuthFlow } from "../auth.js";

// Mock os.homedir at system boundary for config file isolation
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: vi.fn(),
  };
});

describe("auth", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-auth-"));
    vi.mocked(os.homedir).mockReturnValue(tempDir);
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  describe("isAuthenticated", () => {
    it("should return true when VM0_TOKEN env var exists", async () => {
      vi.stubEnv("VM0_TOKEN", "test-token");

      const result = await isAuthenticated();

      expect(result).toBe(true);
    });

    it("should return false when no token", async () => {
      // No VM0_TOKEN env var, no config file

      const result = await isAuthenticated();

      expect(result).toBe(false);
    });
  });

  describe("runAuthFlow", () => {
    it("should complete auth flow and save config on success", async () => {
      server.use(
        http.post("http://localhost:3000/api/cli/auth/device", () => {
          return HttpResponse.json({
            device_code: "device-code-123",
            user_code: "USER-CODE",
            verification_path: "/cli-auth",
            expires_in: 900,
            interval: 1,
          });
        }),
        http.post("http://localhost:3000/api/cli/auth/token", () => {
          return HttpResponse.json({
            access_token: "access-token-123",
          });
        }),
      );

      const callbacks = {
        onInitiating: vi.fn(),
        onDeviceCodeReady: vi.fn(),
        onSuccess: vi.fn(),
        onError: vi.fn(),
      };

      await runAuthFlow(callbacks);

      // Verify callbacks were called
      expect(callbacks.onInitiating).toHaveBeenCalled();
      expect(callbacks.onDeviceCodeReady).toHaveBeenCalledWith(
        "http://localhost:3000/cli-auth",
        "USER-CODE",
        15,
      );
      expect(callbacks.onSuccess).toHaveBeenCalled();
      expect(callbacks.onError).not.toHaveBeenCalled();

      // Verify config was saved to filesystem
      const configPath = path.join(tempDir, ".vm0", "config.json");
      expect(existsSync(configPath)).toBe(true);

      const configContent = await readFile(configPath, "utf-8");
      const config = JSON.parse(configContent);
      expect(config.token).toBe("access-token-123");
      expect(config.apiUrl).toBe("http://localhost:3000");
    });

    it("should throw on expired token", async () => {
      server.use(
        http.post("http://localhost:3000/api/cli/auth/device", () => {
          return HttpResponse.json({
            device_code: "device-code-123",
            user_code: "USER-CODE",
            verification_path: "/cli-auth",
            expires_in: 900,
            interval: 1,
          });
        }),
        http.post("http://localhost:3000/api/cli/auth/token", () => {
          return HttpResponse.json({ error: "expired_token" });
        }),
      );

      const callbacks = { onError: vi.fn() };

      await expect(runAuthFlow(callbacks)).rejects.toThrow(
        "The device code has expired",
      );
      expect(callbacks.onError).toHaveBeenCalled();
    });

    it("should throw on failed device code request", async () => {
      server.use(
        http.post("http://localhost:3000/api/cli/auth/device", () => {
          return new HttpResponse(null, {
            status: 500,
            statusText: "Internal Server Error",
          });
        }),
      );

      await expect(runAuthFlow()).rejects.toThrow(
        "Failed to request device code",
      );
    });

    it("should throw with error description on auth failure", async () => {
      server.use(
        http.post("http://localhost:3000/api/cli/auth/device", () => {
          return HttpResponse.json({
            device_code: "device-code-123",
            user_code: "USER-CODE",
            verification_path: "/cli-auth",
            expires_in: 900,
            interval: 1,
          });
        }),
        http.post("http://localhost:3000/api/cli/auth/token", () => {
          return HttpResponse.json({
            error: "access_denied",
            error_description: "User denied access",
          });
        }),
      );

      await expect(runAuthFlow()).rejects.toThrow(
        "Authentication failed: User denied access",
      );
    });
  });
});
