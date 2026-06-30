/**
 * Tests for zero chat rename command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend rename route via MSW
 * - Real (internal): CLI argument parsing, API client, env handling
 */

import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { zeroChatCommand } from "../index";

const THREAD_ID = "00000000-0000-4000-8000-000000000001";
const RENAME_URL = `http://localhost:3000/api/zero/chat-threads/${THREAD_ID}/rename`;

describe("zero chat rename command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
    vi.stubEnv("ZERO_CHAT_THREAD_ID", THREAD_ID);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
  });

  it("renames the current chat thread and prints a human-readable summary", async () => {
    server.use(
      http.post(RENAME_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-zero-token",
        );
        await expect(request.json()).resolves.toStrictEqual({
          title: "Launch plan",
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await zeroChatCommand.parseAsync([
      "node",
      "cli",
      "rename",
      "Launch",
      "plan",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Chat title updated");
    expect(output).toContain(`Thread: ${THREAD_ID}`);
    expect(output).toContain("Title:  Launch plan");
  });

  it("prints JSON output when --json is passed", async () => {
    server.use(
      http.post(RENAME_URL, async ({ request }) => {
        await expect(request.json()).resolves.toStrictEqual({
          title: "Launch plan",
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await zeroChatCommand.parseAsync([
      "node",
      "cli",
      "rename",
      "Launch",
      "plan",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        threadId: THREAD_ID,
        title: "Launch plan",
      },
    );
  });

  it("rejects whitespace-only titles before calling the API", async () => {
    await expect(async () => {
      await zeroChatCommand.parseAsync(["node", "cli", "rename", "   "]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Title is required");
    expect(stderr).toContain('Run: zero chat rename "New title"');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("requires ZERO_CHAT_THREAD_ID from the current web chat", async () => {
    vi.stubEnv("ZERO_CHAT_THREAD_ID", undefined);

    await expect(async () => {
      await zeroChatCommand.parseAsync([
        "node",
        "cli",
        "rename",
        "Launch plan",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("ZERO_CHAT_THREAD_ID is not set");
    expect(stderr).toContain("Run this command from a Zero web chat thread.");
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
