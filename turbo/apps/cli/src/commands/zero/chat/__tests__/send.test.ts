/**
 * Tests for zero chat message send command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { sendCommand } from "../message/send";
import chalk from "chalk";

const CHAT_MESSAGE_URL =
  "http://localhost:3000/api/zero/integrations/chat/message";

describe("zero chat message send command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
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

  describe("successful send", () => {
    it("should send a message to an existing thread", async () => {
      server.use(
        http.post(CHAT_MESSAGE_URL, () => {
          return HttpResponse.json(
            {
              messageId: "msg-123",
              threadId: "thread-456",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            { status: 201 },
          );
        }),
      );

      await sendCommand.parseAsync([
        "node",
        "cli",
        "--thread",
        "550e8400-e29b-41d4-a716-446655440000",
        "--text",
        "hello world",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Message sent");
      expect(logCalls).toContain("msg-123");
      expect(logCalls).toContain("thread-456");
    });

    it("should send a message with --agent (new thread)", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(CHAT_MESSAGE_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            {
              messageId: "msg-789",
              threadId: "thread-new",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            { status: 201 },
          );
        }),
      );

      await sendCommand.parseAsync([
        "node",
        "cli",
        "--agent",
        "550e8400-e29b-41d4-a716-446655440001",
        "--text",
        "Hello from agent!",
      ]);

      expect(capturedBody).toMatchObject({
        agent: "550e8400-e29b-41d4-a716-446655440001",
        text: "Hello from agent!",
      });
      expect(capturedBody).not.toHaveProperty("thread");

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Message sent");
    });

    it("should send a message with --title when creating a new thread", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(CHAT_MESSAGE_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            {
              messageId: "msg-title",
              threadId: "thread-titled",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            { status: 201 },
          );
        }),
      );

      await sendCommand.parseAsync([
        "node",
        "cli",
        "--agent",
        "550e8400-e29b-41d4-a716-446655440001",
        "--text",
        "Hello!",
        "--title",
        "greeting",
      ]);

      expect(capturedBody).toMatchObject({
        agent: "550e8400-e29b-41d4-a716-446655440001",
        text: "Hello!",
        title: "greeting",
      });

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Message sent");
      expect(logCalls).toContain("thread-titled");
    });
  });

  describe("validation errors", () => {
    it("should error when both --thread and --agent are provided", async () => {
      await expect(async () => {
        await sendCommand.parseAsync([
          "node",
          "cli",
          "--thread",
          "550e8400-e29b-41d4-a716-446655440000",
          "--agent",
          "550e8400-e29b-41d4-a716-446655440001",
          "--text",
          "hello",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--thread and --agent are mutually exclusive"),
      );
    });

    it("should error when neither --thread nor --agent is provided", async () => {
      await expect(async () => {
        await sendCommand.parseAsync(["node", "cli", "--text", "hello"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Either --thread or --agent must be provided"),
      );
    });

    it("should error when --text is not provided", async () => {
      await expect(async () => {
        await sendCommand.parseAsync([
          "node",
          "cli",
          "--thread",
          "550e8400-e29b-41d4-a716-446655440000",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--text is required"),
      );
    });
  });

  describe("API errors", () => {
    it("should handle 401 unauthorized", async () => {
      server.use(
        http.post(CHAT_MESSAGE_URL, () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await sendCommand.parseAsync([
          "node",
          "cli",
          "--thread",
          "550e8400-e29b-41d4-a716-446655440000",
          "--text",
          "hello",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
    });

    it("should handle 403 missing capability", async () => {
      server.use(
        http.post(CHAT_MESSAGE_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "Missing required capability: chat-message:write",
                code: "FORBIDDEN",
              },
            },
            { status: 403 },
          );
        }),
      );

      await expect(async () => {
        await sendCommand.parseAsync([
          "node",
          "cli",
          "--thread",
          "550e8400-e29b-41d4-a716-446655440000",
          "--text",
          "hello",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Missing required capability"),
      );
    });

    it("should handle 404 thread not found", async () => {
      server.use(
        http.post(CHAT_MESSAGE_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "Chat thread not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await sendCommand.parseAsync([
          "node",
          "cli",
          "--thread",
          "550e8400-e29b-41d4-a716-446655440000",
          "--text",
          "hello",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Chat thread not found"),
      );
    });
  });
});
