/**
 * Tests for auth login command
 *
 * Covers:
 * - Initial authentication message
 * - Device code request errors
 * - API URL configuration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { loginCommand } from "../login";
import { mkdtempSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

// Mock os.homedir to use temp directory
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-auth-login-home-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => TEST_HOME,
  };
});

describe("auth login", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockStdoutWrite = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);

  beforeEach(async () => {
    vi.clearAllMocks();
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");

    // Ensure clean config state
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockStdoutWrite.mockClear();
    vi.unstubAllEnvs();

    // Clean up config
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  describe("authentication flow", () => {
    it("should show initiating message", async () => {
      server.use(
        http.post("http://localhost:3000/api/cli/auth/device", () => {
          return HttpResponse.json({
            device_code: "test-device-code",
            user_code: "TEST-CODE",
            verification_path: "/auth/device",
            expires_in: 300,
            interval: 5,
          });
        }),
        http.post("http://localhost:3000/api/cli/auth/token", () => {
          // Return success immediately to avoid polling
          return HttpResponse.json({
            access_token: "test-access-token",
            token_type: "bearer",
          });
        }),
      );

      await loginCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Initiating authentication"),
      );
    });

    it("should show device code and verification URL", async () => {
      server.use(
        http.post("http://localhost:3000/api/cli/auth/device", () => {
          return HttpResponse.json({
            device_code: "test-device-code",
            user_code: "ABCD-1234",
            verification_path: "/auth/device",
            expires_in: 300,
            interval: 5,
          });
        }),
        http.post("http://localhost:3000/api/cli/auth/token", () => {
          // Return success immediately to avoid polling
          return HttpResponse.json({
            access_token: "test-access-token",
            token_type: "bearer",
          });
        }),
      );

      await loginCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Device code generated"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("http://localhost:3000/auth/device"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("ABCD-1234"),
      );
    });

    it("should save token on successful authentication", async () => {
      server.use(
        http.post("http://localhost:3000/api/cli/auth/device", () => {
          return HttpResponse.json({
            device_code: "test-device-code",
            user_code: "TEST-CODE",
            verification_path: "/auth/device",
            expires_in: 300,
            interval: 5,
          });
        }),
        http.post("http://localhost:3000/api/cli/auth/token", () => {
          return HttpResponse.json({
            access_token: "saved-access-token",
            token_type: "bearer",
          });
        }),
      );

      await loginCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Authentication successful"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("credentials have been saved"),
      );

      // Verify config was saved
      const configPath = path.join(TEST_HOME, ".vm0", "config.json");
      const configContent = await fs.readFile(configPath, "utf8");
      const config = JSON.parse(configContent);
      expect(config.token).toBe("saved-access-token");
    });
  });

  describe("error handling", () => {
    it("should fail if device code request fails", async () => {
      server.use(
        http.post("http://localhost:3000/api/cli/auth/device", () => {
          return HttpResponse.json({ error: "server_error" }, { status: 500 });
        }),
      );

      await expect(async () => {
        await loginCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow();

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Initiating authentication"),
      );
    });

    it("should handle expired token error", async () => {
      server.use(
        http.post("http://localhost:3000/api/cli/auth/device", () => {
          return HttpResponse.json({
            device_code: "test-device-code",
            user_code: "TEST-CODE",
            verification_path: "/auth/device",
            expires_in: 300,
            interval: 5,
          });
        }),
        http.post("http://localhost:3000/api/cli/auth/token", () => {
          return HttpResponse.json({
            error: "expired_token",
            error_description: "The device code has expired",
          });
        }),
      );

      await expect(async () => {
        await loginCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("expired"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle authentication error", async () => {
      server.use(
        http.post("http://localhost:3000/api/cli/auth/device", () => {
          return HttpResponse.json({
            device_code: "test-device-code",
            user_code: "TEST-CODE",
            verification_path: "/auth/device",
            expires_in: 300,
            interval: 5,
          });
        }),
        http.post("http://localhost:3000/api/cli/auth/token", () => {
          return HttpResponse.json({
            error: "access_denied",
            error_description: "User denied access",
          });
        }),
      );

      await expect(async () => {
        await loginCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Authentication failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
