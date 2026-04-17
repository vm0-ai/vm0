/**
 * Tests for zero voice-chat context append command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { voiceChatContextAppendCommand } from "../context/append";

const CONTEXT_URL = "http://localhost:3000/api/zero/voice-chat/:id/context";

describe("zero voice-chat context append command", () => {
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

  describe("successful append", () => {
    it("should append an event with --content", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const createdEvent = {
        id: "evt-1",
        seq: 1,
        source: "slow-brain",
        type: "directive",
        content: "Done",
        createdAt: "2026-01-01T00:00:00Z",
      };

      server.use(
        http.post(CONTEXT_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ event: createdEvent }, { status: 200 });
        }),
      );

      await voiceChatContextAppendCommand.parseAsync([
        "node",
        "cli",
        "session-123",
        "--source",
        "slow-brain",
        "--type",
        "directive",
        "--content",
        "Done",
      ]);

      expect(capturedBody).toMatchObject({
        source: "slow-brain",
        type: "directive",
        content: "Done",
      });

      expect(mockConsoleLog).toHaveBeenCalledWith(
        JSON.stringify(createdEvent, null, 2),
      );
    });

    it("should append an event without --content", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(CONTEXT_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            {
              event: {
                id: "evt-1",
                seq: 1,
                source: "slow-brain",
                type: "heartbeat",
                content: null,
                createdAt: "2026-01-01T00:00:00Z",
              },
            },
            { status: 200 },
          );
        }),
      );

      await voiceChatContextAppendCommand.parseAsync([
        "node",
        "cli",
        "session-123",
        "--source",
        "slow-brain",
        "--type",
        "heartbeat",
      ]);

      expect(capturedBody).toMatchObject({
        source: "slow-brain",
        type: "heartbeat",
      });
    });
  });

  describe("API errors", () => {
    it("should handle 401 unauthorized", async () => {
      server.use(
        http.post(CONTEXT_URL, () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await voiceChatContextAppendCommand.parseAsync([
          "node",
          "cli",
          "session-123",
          "--source",
          "slow-brain",
          "--type",
          "directive",
          "--content",
          "Done",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
    });

    it("should handle 404 not found", async () => {
      server.use(
        http.post(CONTEXT_URL, () => {
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
        await voiceChatContextAppendCommand.parseAsync([
          "node",
          "cli",
          "session-123",
          "--source",
          "slow-brain",
          "--type",
          "directive",
          "--content",
          "Done",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Voice-chat session not found"),
      );
    });
  });
});
