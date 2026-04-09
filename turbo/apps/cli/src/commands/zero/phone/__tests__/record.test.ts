/**
 * Tests for zero phone record command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { recordCommand } from "../record";
import chalk from "chalk";

const mockCallList = {
  data: [
    {
      id: "call_001",
      fromNumber: "+14155551234",
      toNumber: "+18001234567",
      status: "completed",
      durationSeconds: 120,
      lastTranscriptSnippet: "Hello, how can I help?",
    },
    {
      id: "call_002",
      fromNumber: "+14155559999",
      toNumber: "+18001234567",
      status: "completed",
      durationSeconds: 60,
      lastTranscriptSnippet: null,
    },
  ],
  total: 2,
  hasMore: false,
};

const mockCallDetail = {
  call: {
    id: "call_001",
    fromNumber: "+14155551234",
    toNumber: "+18001234567",
    status: "completed",
    durationSeconds: 120,
    startedAt: "2026-04-08T10:00:00Z",
  },
  transcript: [
    { role: "agent", text: "Hello, how can I help?" },
    { role: "user", text: "I have a question about my account." },
  ],
};

describe("zero phone record command", () => {
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

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("list calls (no call ID)", () => {
    it("should display recent calls", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/phone-calls", () => {
          return HttpResponse.json(mockCallList);
        }),
      );

      await recordCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Recent Calls");
      expect(logCalls).toContain("call_001");
      expect(logCalls).toContain("call_002");
      expect(logCalls).toContain("+14155551234");
      expect(logCalls).toContain("Showing 2 of 2 call(s)");
    });

    it("should display empty state when no calls exist", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/phone-calls", () => {
          return HttpResponse.json({ data: [], total: 0, hasMore: false });
        }),
      );

      await recordCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No phone calls found");
    });

    it("should pass --limit option to the API", async () => {
      let capturedUrl = "";
      server.use(
        http.get(
          "http://localhost:3000/api/zero/phone-calls",
          ({ request }) => {
            capturedUrl = request.url;
            return HttpResponse.json(mockCallList);
          },
        ),
      );

      await recordCommand.parseAsync(["node", "cli", "--limit", "5"]);

      expect(capturedUrl).toContain("limit=5");
    });
  });

  describe("call detail (with call ID)", () => {
    it("should display call detail and transcript", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/phone-calls/call_001", () => {
          return HttpResponse.json(mockCallDetail);
        }),
      );

      await recordCommand.parseAsync(["node", "cli", "call_001"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Call Detail");
      expect(logCalls).toContain("call_001");
      expect(logCalls).toContain("+14155551234");
      expect(logCalls).toContain("Transcript");
      expect(logCalls).toContain("Hello, how can I help?");
    });
  });

  describe("error handling", () => {
    it("should handle API errors when listing calls", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/phone-calls", () => {
          return HttpResponse.json(
            { error: "Phone is not configured for this org" },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await recordCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
