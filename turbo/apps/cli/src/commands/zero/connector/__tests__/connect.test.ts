/**
 * Tests for zero connector connect command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { connectCommand } from "../connect";
import chalk from "chalk";

describe("zero connector connect command", () => {
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

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockStdoutWrite.mockClear();
  });

  describe("OAuth flow", () => {
    it("should complete OAuth device flow successfully", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/connectors/:type/sessions",
          () => {
            return HttpResponse.json({
              id: "session-001",
              code: "ABC123",
              type: "github",
              status: "pending",
              verificationUrl: "/authorize/github?code=ABC123",
              expiresIn: 900,
              interval: 5,
              errorMessage: null,
            });
          },
        ),
        http.get(
          "http://localhost:3000/api/zero/connectors/:type/sessions/:sessionId",
          () => {
            return HttpResponse.json({
              status: "complete",
              errorMessage: null,
            });
          },
        ),
      );

      await connectCommand.parseAsync(["node", "cli", "github"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Session created");
      expect(logCalls).toContain("/authorize/github?code=ABC123");
      expect(logCalls).toContain("Connector");
      expect(logCalls).toContain("connected");
    });

    it("should handle session creation failure", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/connectors/:type/sessions",
          () => {
            return HttpResponse.json(
              {
                error: {
                  message: "Bad request",
                  code: "BAD_REQUEST",
                },
              },
              { status: 400 },
            );
          },
        ),
      );

      await expect(async () => {
        await connectCommand.parseAsync(["node", "cli", "github"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Bad request"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("API token flow", () => {
    it("should connect via --token flag for api-token connector", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/secrets", () => {
          return HttpResponse.json(
            { name: "AXIOM_TOKEN", createdAt: "2025-01-01T00:00:00Z" },
            { status: 201 },
          );
        }),
      );

      await connectCommand.parseAsync([
        "node",
        "cli",
        "axiom",
        "--token",
        "xaat-test-token",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Connector");
      expect(logCalls).toContain("connected");
    });
  });

  describe("input validation", () => {
    it("should reject invalid connector type", async () => {
      await expect(async () => {
        await connectCommand.parseAsync(["node", "cli", "invalid-type"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unknown connector type: invalid-type"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/connectors/:type/sessions",
          () => {
            return HttpResponse.json(
              {
                error: {
                  message: "Not authenticated",
                  code: "UNAUTHORIZED",
                },
              },
              { status: 401 },
            );
          },
        ),
      );

      await expect(async () => {
        await connectCommand.parseAsync(["node", "cli", "github"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
