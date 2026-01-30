/**
 * Tests for agent list command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { listCommand } from "../list";

describe("agent list command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("successful list", () => {
    it("should display composes in table format", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes/list", () => {
          return HttpResponse.json({
            composes: [
              {
                name: "my-agent",
                headVersionId: "abc123def456",
                updatedAt: new Date().toISOString(),
              },
              {
                name: "another-agent",
                headVersionId: "xyz789ghi012",
                updatedAt: new Date().toISOString(),
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("NAME");
      expect(logCalls).toContain("VERSION");
      expect(logCalls).toContain("UPDATED");
      expect(logCalls).toContain("my-agent");
      expect(logCalls).toContain("another-agent");
      expect(logCalls).toContain("abc123de"); // First 8 chars of version
    });

    it("should display empty state message when no composes", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes/list", () => {
          return HttpResponse.json({ composes: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No agent composes found");
      expect(logCalls).toContain("vm0 compose");
    });

    it("should handle compose without version", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes/list", () => {
          return HttpResponse.json({
            composes: [
              {
                name: "draft-agent",
                headVersionId: null,
                updatedAt: new Date().toISOString(),
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("draft-agent");
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      vi.unstubAllEnvs();
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");
      // No token set

      await expect(async () => {
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to list"),
      );
    });

    it("should handle API error response", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes/list", () => {
          return HttpResponse.json(
            { error: { message: "Internal server error" } },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to list"),
      );
    });
  });
});
