/**
 * Tests for `zero search --source chat`.
 *
 * Entry point: zeroSearchCommand.parseAsync()
 * Mock (external): Web API via MSW
 * Real (internal): flag parsing, time parsing, renderers, error mapping
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { zeroSearchCommand } from "../index";

function makeMessage(params: {
  content: string;
  role?: "user" | "assistant";
  createdAt?: string;
  messageId?: string;
}) {
  return {
    messageId: params.messageId ?? "msg-1",
    chatThreadId: "thread-1",
    role: params.role ?? "user",
    content: params.content,
    createdAt: params.createdAt ?? "2024-01-15T10:30:00Z",
    sequenceNumber: null,
    runId: null,
  };
}

describe("zero search --source chat", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    // Clear any prior spy call history before each test so assertions only
    // see calls made by the current case.
    vi.clearAllMocks();
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    // Commander retains collector state across parseAsync calls on the
    // same command instance. Reset before each case.
    zeroSearchCommand.setOptionValue("source", []);
  });

  afterEach(() => {
    // Restore stubbed env vars so state never bleeds across test files.
    vi.unstubAllEnvs();
  });

  it("renders chat search results grouped by thread", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/chat/search", () => {
        return HttpResponse.json({
          results: [
            {
              chatThreadId: "thread-abc",
              agentName: "my-agent",
              matchedMessage: makeMessage({
                content: "OOM killed the build",
              }),
              contextBefore: [],
              contextAfter: [],
            },
          ],
          hasMore: false,
        });
      }),
    );

    await zeroSearchCommand.parseAsync([
      "node",
      "cli",
      "OOM",
      "--source",
      "chat",
    ]);

    const logs = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logs).toContain("thread-abc");
    expect(logs).toContain("my-agent");
    expect(logs).toContain("OOM killed the build");
  });

  it("handles no matches", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/chat/search", () => {
        return HttpResponse.json({ results: [], hasMore: false });
      }),
    );

    await zeroSearchCommand.parseAsync([
      "node",
      "cli",
      "nothing",
      "--source",
      "chat",
    ]);

    const logs = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logs).toContain("No matches found");
    expect(logs).toContain("--since 30d");
  });

  it("passes keyword and -C context to API", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get("http://localhost:3000/api/zero/chat/search", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ results: [], hasMore: false });
      }),
    );

    await zeroSearchCommand.parseAsync([
      "node",
      "cli",
      "error",
      "--source",
      "chat",
      "-C",
      "3",
    ]);

    expect(capturedUrl?.searchParams.get("keyword")).toBe("error");
    expect(capturedUrl?.searchParams.get("before")).toBe("3");
    expect(capturedUrl?.searchParams.get("after")).toBe("3");
  });

  it("passes -A and -B independently", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get("http://localhost:3000/api/zero/chat/search", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ results: [], hasMore: false });
      }),
    );

    await zeroSearchCommand.parseAsync([
      "node",
      "cli",
      "error",
      "--source",
      "chat",
      "-A",
      "5",
      "-B",
      "2",
    ]);

    expect(capturedUrl?.searchParams.get("before")).toBe("2");
    expect(capturedUrl?.searchParams.get("after")).toBe("5");
  });

  it("passes --agent as agentId filter to API", async () => {
    let capturedUrl: URL | undefined;
    const agentId = "550e8400-e29b-41d4-a716-446655440001";
    server.use(
      http.get("http://localhost:3000/api/zero/chat/search", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ results: [], hasMore: false });
      }),
    );

    await zeroSearchCommand.parseAsync([
      "node",
      "cli",
      "hello",
      "--source",
      "chat",
      "--agent",
      agentId,
    ]);

    expect(capturedUrl?.searchParams.get("agentId")).toBe(agentId);
  });

  it("rejects --run flag for chat source with clear error", async () => {
    await expect(
      zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "chat",
        "--run",
        "abc12345-1234-1234-1234-123456789abc",
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain("--run is not supported with --source chat");
  });

  it("rejects --limit outside the 1..50 range", async () => {
    await expect(
      zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "chat",
        "--limit",
        "500",
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain("--limit must be between 1 and 50");
  });

  it("rejects --before-context outside the 0..10 range", async () => {
    await expect(
      zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "chat",
        "--before-context",
        "99",
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain("--before-context must be between 0 and 10");
  });

  it("shows the hasMore hint when the API reports more results", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/chat/search", () => {
        return HttpResponse.json({
          results: [
            {
              chatThreadId: "thread-x",
              agentName: "agent",
              matchedMessage: makeMessage({ content: "match" }),
              contextBefore: [],
              contextAfter: [],
            },
          ],
          hasMore: true,
        });
      }),
    );

    await zeroSearchCommand.parseAsync([
      "node",
      "cli",
      "match",
      "--source",
      "chat",
    ]);

    const logs = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logs).toContain("--limit");
  });

  it("surfaces API authentication errors", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/chat/search", () => {
        return HttpResponse.json(
          { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
          { status: 401 },
        );
      }),
    );

    await expect(
      zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "error",
        "--source",
        "chat",
      ]),
    ).rejects.toThrow();

    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain("Not authenticated");
  });
});
