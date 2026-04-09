/**
 * Tests for zero phone call command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { callCommand } from "../call";
import chalk from "chalk";

describe("zero phone call command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("successful call", () => {
    it("should initiate a call and display call ID and status", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/phone-calls", () => {
          return HttpResponse.json({
            callId: "call_abc123",
            status: "initiated",
          });
        }),
      );

      await callCommand.parseAsync(["node", "cli", "+14155551234"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Call initiated");
      expect(logCalls).toContain("call_abc123");
      expect(logCalls).toContain("initiated");
    });

    it("should pass --greeting option to the API", async () => {
      let capturedBody: Record<string, unknown> = {};
      server.use(
        http.post(
          "http://localhost:3000/api/zero/phone-calls",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              callId: "call_xyz",
              status: "initiated",
            });
          },
        ),
      );

      await callCommand.parseAsync([
        "node",
        "cli",
        "+14155551234",
        "--greeting",
        "Hello, how can I help?",
      ]);

      expect(capturedBody.greeting).toBe("Hello, how can I help?");
    });

    it("should pass --system-prompt option to the API", async () => {
      let capturedBody: Record<string, unknown> = {};
      server.use(
        http.post(
          "http://localhost:3000/api/zero/phone-calls",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              callId: "call_xyz",
              status: "initiated",
            });
          },
        ),
      );

      await callCommand.parseAsync([
        "node",
        "cli",
        "+14155551234",
        "--system-prompt",
        "You are a helpful assistant.",
      ]);

      expect(capturedBody.systemPrompt).toBe("You are a helpful assistant.");
    });
  });

  describe("validation", () => {
    it("should reject invalid phone number format", async () => {
      await expect(async () => {
        await callCommand.parseAsync(["node", "cli", "5551234"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid phone number format"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("error handling", () => {
    it("should handle API errors", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/phone-calls", () => {
          return HttpResponse.json(
            { error: "Phone is not configured for this org" },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await callCommand.parseAsync(["node", "cli", "+14155551234"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("file-based input", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true });
    });

    it("should read system prompt from --prompt-file", async () => {
      const promptFile = path.join(tmpDir, "prompt.txt");
      fs.writeFileSync(promptFile, "Custom multi-line\nsystem prompt");

      let capturedBody: Record<string, unknown> = {};
      server.use(
        http.post(
          "http://localhost:3000/api/zero/phone-calls",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              callId: "call_xyz",
              status: "initiated",
            });
          },
        ),
      );

      await callCommand.parseAsync([
        "node",
        "cli",
        "+14155551234",
        "--prompt-file",
        promptFile,
      ]);

      expect(capturedBody.systemPrompt).toBe(
        "Custom multi-line\nsystem prompt",
      );
    });

    it("should read greeting from --greeting-file", async () => {
      const greetingFile = path.join(tmpDir, "greeting.txt");
      fs.writeFileSync(greetingFile, "Hello, welcome to our service!");

      let capturedBody: Record<string, unknown> = {};
      server.use(
        http.post(
          "http://localhost:3000/api/zero/phone-calls",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              callId: "call_xyz",
              status: "initiated",
            });
          },
        ),
      );

      await callCommand.parseAsync([
        "node",
        "cli",
        "+14155551234",
        "--greeting-file",
        greetingFile,
      ]);

      expect(capturedBody.greeting).toBe("Hello, welcome to our service!");
    });

    it("should error if --system-prompt and --prompt-file are both provided", async () => {
      const promptFile = path.join(tmpDir, "prompt.txt");
      fs.writeFileSync(promptFile, "file prompt");

      await expect(async () => {
        await callCommand.parseAsync([
          "node",
          "cli",
          "+14155551234",
          "--system-prompt",
          "inline prompt",
          "--prompt-file",
          promptFile,
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Cannot use both --system-prompt and --prompt-file",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should error if --greeting and --greeting-file are both provided", async () => {
      const greetingFile = path.join(tmpDir, "greeting.txt");
      fs.writeFileSync(greetingFile, "file greeting");

      await expect(async () => {
        await callCommand.parseAsync([
          "node",
          "cli",
          "+14155551234",
          "--greeting",
          "inline greeting",
          "--greeting-file",
          greetingFile,
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Cannot use both --greeting and --greeting-file",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should error if --prompt-file path does not exist", async () => {
      await expect(async () => {
        await callCommand.parseAsync([
          "node",
          "cli",
          "+14155551234",
          "--prompt-file",
          "/nonexistent/path/prompt.txt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("File not found: /nonexistent/path/prompt.txt"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should error if --greeting-file path does not exist", async () => {
      await expect(async () => {
        await callCommand.parseAsync([
          "node",
          "cli",
          "+14155551234",
          "--greeting-file",
          "/nonexistent/path/greeting.txt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "File not found: /nonexistent/path/greeting.txt",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
