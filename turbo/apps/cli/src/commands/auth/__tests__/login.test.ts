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
import {
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_CLI,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@vm0/api-contracts/contracts/client-headers";
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
    homedir: () => {
      return TEST_HOME;
    },
  };
});

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

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
    .mockImplementation(() => {
      return true;
    });

  beforeEach(async () => {
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
      const capturedHeaders: Headers[] = [];
      server.use(
        http.post("http://localhost:3000/api/cli/auth/device", (ctx) => {
          capturedHeaders.push(ctx.request.headers);
          return HttpResponse.json({
            device_code: "test-device-code",
            user_code: "TEST-CODE",
            verification_path: "/auth/device",
            expires_in: 300,
            interval: 5,
          });
        }),
        http.post("http://localhost:3000/api/cli/auth/token", (ctx) => {
          capturedHeaders.push(ctx.request.headers);
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

      expect(capturedHeaders).toHaveLength(2);
      const deviceHeaders = capturedHeaders[0];
      const tokenHeaders = capturedHeaders[1];
      if (!deviceHeaders || !tokenHeaders) {
        throw new Error("Expected device and token requests");
      }

      expect(deviceHeaders.get(CLIENT_VERSION_HEADER)).toBe("0.0.0-test");
      expect(deviceHeaders.get(CLIENT_TYPE_HEADER)).toBe(CLIENT_TYPE_CLI);
      expect(tokenHeaders.get(CLIENT_VERSION_HEADER)).toBe("0.0.0-test");
      expect(tokenHeaders.get(CLIENT_TYPE_HEADER)).toBe(CLIENT_TYPE_CLI);

      const sessionId = requiredHeader(deviceHeaders, CLIENT_SESSION_ID_HEADER);
      expect(requiredHeader(tokenHeaders, CLIENT_SESSION_ID_HEADER)).toBe(
        sessionId,
      );
      expect(requiredHeader(deviceHeaders, CLIENT_REQUEST_ID_HEADER)).not.toBe(
        requiredHeader(tokenHeaders, CLIENT_REQUEST_ID_HEADER),
      );
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
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to request device code"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle network failure", async () => {
      server.use(
        http.post("http://localhost:3000/api/cli/auth/device", () => {
          return HttpResponse.error();
        }),
      );

      await expect(async () => {
        await loginCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should show user-friendly message for 403 Forbidden", async () => {
      server.use(
        http.post("http://localhost:3000/api/cli/auth/device", () => {
          return new HttpResponse(null, { status: 403 });
        }),
      );

      await expect(async () => {
        await loginCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("An unexpected network issue occurred"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
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

      expect(mockConsoleError).toHaveBeenCalledWith(
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

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Authentication failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
