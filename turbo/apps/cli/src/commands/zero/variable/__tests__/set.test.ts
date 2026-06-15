/**
 * Tests for zero variable set command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { setCommand } from "../set";
import chalk from "chalk";

describe("zero variable set command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  describe("successful set", () => {
    it("should set a variable with positional value", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/variables", () => {
          return HttpResponse.json(
            {
              name: "MY_VAR",
              value: "my-value",
              updatedAt: "2025-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
      );

      await setCommand.parseAsync(["node", "cli", "MY_VAR", "my-value"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Variable "MY_VAR" saved');
    });

    it("should set a variable with --description", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/zero/variables",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(
              {
                name: "API_URL",
                value: "https://api.example.com",
                description: "External API endpoint",
                updatedAt: "2025-01-01T00:00:00Z",
              },
              { status: 201 },
            );
          },
        ),
      );

      await setCommand.parseAsync([
        "node",
        "cli",
        "API_URL",
        "https://api.example.com",
        "--description",
        "External API endpoint",
      ]);

      expect(capturedBody).toMatchObject({
        name: "API_URL",
        value: "https://api.example.com",
        description: "External API endpoint",
      });
    });
  });

  describe("input validation", () => {
    it("should show helpful hint for invalid variable name", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/variables", () => {
          return HttpResponse.json(
            {
              error: {
                message:
                  "Name must contain only uppercase letters, digits, and underscores",
                code: "BAD_REQUEST",
              },
            },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "my-invalid-var", "value"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("must contain only uppercase"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("MY_VAR"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/variables", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Not authenticated",
                code: "UNAUTHORIZED",
              },
            },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "MY_VAR", "value"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle generic API error", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/variables", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Internal server error",
                code: "SERVER_ERROR",
              },
            },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "MY_VAR", "value"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Internal server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
