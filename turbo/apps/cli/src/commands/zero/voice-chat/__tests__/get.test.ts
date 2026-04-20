/**
 * Tests for zero voice-chat context get command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { voiceChatContextGetCommand } from "../context/get";

const CONTEXT_URL = "http://localhost:3000/api/zero/voice-chat/:id/context";

describe("zero voice-chat context get command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  describe("successful get", () => {
    it("should get context events for a session", async () => {
      const events = {
        events: [
          {
            id: "evt-1",
            seq: 1,
            source: "user",
            type: "message",
            content: "hello",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      };

      server.use(
        http.get(CONTEXT_URL, () => {
          return HttpResponse.json(events, { status: 200 });
        }),
      );

      await voiceChatContextGetCommand.parseAsync([
        "node",
        "cli",
        "session-123",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        JSON.stringify(events, null, 2),
      );
    });

    it("should pass --after query parameter", async () => {
      let capturedUrl: URL | undefined;

      server.use(
        http.get(CONTEXT_URL, ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ events: [] }, { status: 200 });
        }),
      );

      await voiceChatContextGetCommand.parseAsync([
        "node",
        "cli",
        "session-123",
        "--after",
        "5",
      ]);

      expect(capturedUrl?.searchParams.get("after")).toBe("5");
    });
  });

  describe("API errors", () => {
    it("should handle 401 unauthorized", async () => {
      server.use(
        http.get(CONTEXT_URL, () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await voiceChatContextGetCommand.parseAsync([
          "node",
          "cli",
          "session-123",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
    });

    it("should handle 404 not found", async () => {
      server.use(
        http.get(CONTEXT_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "Voice-chat session not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await voiceChatContextGetCommand.parseAsync([
          "node",
          "cli",
          "session-123",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Voice-chat session not found"),
      );
    });
  });
});
