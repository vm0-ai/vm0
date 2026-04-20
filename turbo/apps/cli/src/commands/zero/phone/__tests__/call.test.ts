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
import { callCommand, delay } from "../call";
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

  describe("fire-and-forget mode", () => {
    it("should initiate a call and return immediately", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/phone-calls", () => {
          return HttpResponse.json({
            callId: "call_abc123",
            status: "initiated",
          });
        }),
      );

      await callCommand.parseAsync([
        "node",
        "cli",
        "+14155551234",
        "--mode",
        "fire-and-forget",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Call initiated");
      expect(logCalls).toContain("call_abc123");
      expect(logCalls).toContain("initiated");
    });
  });

  describe("onhold mode", () => {
    const originalDelayMs = delay.ms;

    afterEach(() => {
      delay.ms = originalDelayMs;
    });

    it("should poll until call completes and print transcript", async () => {
      delay.ms = () => {
        return Promise.resolve();
      };
      let pollCount = 0;

      server.use(
        http.post("http://localhost:3000/api/zero/phone-calls", () => {
          return HttpResponse.json({
            callId: "call_hold123",
            status: "initiated",
          });
        }),
        http.get(
          "http://localhost:3000/api/zero/phone-calls/call_hold123",
          () => {
            pollCount++;
            if (pollCount < 2) {
              return HttpResponse.json({
                call: {
                  id: "call_hold123",
                  status: "active",
                  fromNumber: "+16067551512",
                  toNumber: "+14155551234",
                  durationSeconds: 0,
                  startedAt: "2026-04-09T08:00:00Z",
                },
                transcript: null,
              });
            }
            return HttpResponse.json({
              call: {
                id: "call_hold123",
                status: "completed",
                fromNumber: "+16067551512",
                toNumber: "+14155551234",
                durationSeconds: 25,
                startedAt: "2026-04-09T08:00:00Z",
              },
              transcript: [
                { role: "agent", text: "Hello, is this a good time?" },
                { role: "user", text: "Yes, go ahead." },
              ],
            });
          },
        ),
      );

      await callCommand.parseAsync([
        "node",
        "cli",
        "+14155551234",
        "--mode",
        "onhold",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Call initiated");
      expect(logCalls).toContain("Call Detail");
      expect(logCalls).toContain("Transcript");
      expect(logCalls).toContain("Hello, is this a good time?");
      expect(logCalls).toContain("Yes, go ahead.");
      expect(pollCount).toBe(2);
    });
  });

  describe("validation", () => {
    it("should reject invalid phone number format", async () => {
      await expect(async () => {
        await callCommand.parseAsync([
          "node",
          "cli",
          "5551234",
          "--mode",
          "fire-and-forget",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid phone number format"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should require --mode flag", async () => {
      await expect(async () => {
        await callCommand.parseAsync(["node", "cli", "+14155551234"]);
      }).rejects.toThrow("process.exit called");

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
        await callCommand.parseAsync([
          "node",
          "cli",
          "+14155551234",
          "--mode",
          "fire-and-forget",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("--system-prompt-file", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true });
    });

    it("should read system prompt from file and pass to API", async () => {
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
        "--system-prompt-file",
        promptFile,
        "--mode",
        "fire-and-forget",
      ]);

      expect(capturedBody.systemPrompt).toBe(
        "Custom multi-line\nsystem prompt",
      );
    });

    it("should error if file does not exist", async () => {
      await expect(async () => {
        await callCommand.parseAsync([
          "node",
          "cli",
          "+14155551234",
          "--system-prompt-file",
          "/nonexistent/path/prompt.txt",
          "--mode",
          "fire-and-forget",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("File not found: /nonexistent/path/prompt.txt"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
