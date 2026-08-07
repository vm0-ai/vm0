import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { zeroChatCommand } from "../index";

const CURRENT_THREAD_ID = "00000000-0000-4000-8000-000000000001";
const NEW_THREAD_ID = "00000000-0000-4000-8000-000000000002";
const AGENT_ID = "00000000-0000-4000-8000-000000000010";
const OTHER_AGENT_ID = "00000000-0000-4000-8000-000000000011";
const CREATE_URL = "http://localhost:3000/api/zero/chat-threads";

function metadataUrl(threadId: string): string {
  return `http://localhost:3000/api/zero/chat-threads/${threadId}/metadata`;
}

describe("zero chat create command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
    vi.stubEnv("ZERO_CHAT_THREAD_ID", CURRENT_THREAD_ID);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
  });

  it("creates a thread under this chat's agent and inherits the run model", async () => {
    server.use(
      http.get(metadataUrl(CURRENT_THREAD_ID), () => {
        return HttpResponse.json({
          id: CURRENT_THREAD_ID,
          agentId: AGENT_ID,
          title: "Current chat",
          selectedModel: "claude-sonnet-5",
        });
      }),
      http.post(CREATE_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-zero-token",
        );
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toStrictEqual({
          agentId: AGENT_ID,
          title: "Deep dive on P2",
        });
        return HttpResponse.json(
          {
            id: NEW_THREAD_ID,
            title: "Deep dive on P2",
            createdAt: "2026-07-30T10:00:00.000Z",
            selectedModel: "claude-sonnet-5",
          },
          { status: 201 },
        );
      }),
    );

    await zeroChatCommand.parseAsync([
      "node",
      "cli",
      "create",
      "Deep dive",
      "on P2",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        threadId: NEW_THREAD_ID,
        title: "Deep dive on P2",
        selectedModel: "claude-sonnet-5",
        agentId: AGENT_ID,
      },
    );
  });

  it("guides to the first send with an explicit agent and model", async () => {
    server.use(
      http.post(CREATE_URL, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toStrictEqual({
          agentId: OTHER_AGENT_ID,
          title: "Launch plan",
          model: "claude-sonnet-5",
        });
        return HttpResponse.json(
          {
            id: NEW_THREAD_ID,
            title: "Launch plan",
            createdAt: "2026-07-30T10:00:00.000Z",
            selectedModel: "claude-sonnet-5",
          },
          { status: 201 },
        );
      }),
    );

    await zeroChatCommand.parseAsync([
      "node",
      "cli",
      "create",
      "Launch plan",
      "--agent",
      OTHER_AGENT_ID,
      "--model",
      "claude-sonnet-5",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Chat thread created");
    expect(output).toContain(`Thread: ${NEW_THREAD_ID}`);
    expect(output).toContain("Title:  Launch plan");
    expect(output).toContain("Model:  claude-sonnet-5");
    expect(output).toContain(`Agent:  ${OTHER_AGENT_ID}`);
    expect(output).toContain(
      `zero chat send --thread-id ${NEW_THREAD_ID} --text "<message>"`,
    );
  });

  it("requires an agent when it runs outside a web chat thread", async () => {
    vi.stubEnv("ZERO_CHAT_THREAD_ID", undefined);

    await expect(async () => {
      await zeroChatCommand.parseAsync([
        "node",
        "cli",
        "create",
        "Launch plan",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("ZERO_CHAT_THREAD_ID is not set");
    expect(stderr).toContain("Pass --agent <agent-id>");
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
