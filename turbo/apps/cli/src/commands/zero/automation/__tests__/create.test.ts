/**
 * Tests for `zero automation create` (v2 unified automations).
 *
 * Tests command-level behavior via parseAsync() following CLI testing
 * principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { createCommand } from "../create";
import chalk from "chalk";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const AUTOMATION_ID = "11111111-1111-4111-8111-111111111111";
const TRIGGER_ID = "22222222-2222-4222-8222-222222222222";

const mockCompose = {
  id: AGENT_ID,
  name: "my-agent",
  headVersionId: "ver-001",
  content: null,
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
};

function baseAutomation(triggers: unknown[]) {
  return {
    id: AUTOMATION_ID,
    agentId: AGENT_ID,
    displayName: "my-agent",
    userId: "user-001",
    name: "alerts",
    description: null,
    instruction: "Summarize alerts",
    appendSystemPrompt: null,
    enabled: true,
    chatThreadId: "550e8400-e29b-41d4-a716-446655440099",
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    triggers,
  };
}

const cronTrigger = {
  id: TRIGGER_ID,
  automationId: AUTOMATION_ID,
  enabled: true,
  kind: "cron",
  cronExpression: "0 9 * * *",
  timezone: "UTC",
  nextRunAt: "2026-06-12T09:00:00Z",
  lastRunAt: null,
  consecutiveFailures: 0,
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
};

const webhookTrigger = {
  id: TRIGGER_ID,
  automationId: AUTOMATION_ID,
  enabled: true,
  kind: "webhook",
  webhookToken: "whk_deadbeef",
  webhookUrl: "http://localhost:3000/api/automations/webhooks/whk_deadbeef",
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
};

function composeByNameHandler() {
  return http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get("name") !== "my-agent") {
      return HttpResponse.json(
        { error: { message: "Not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    return HttpResponse.json(mockCompose);
  });
}

describe("zero automation create command", () => {
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

  it("should create a triggerless automation", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    server.use(
      composeByNameHandler(),
      http.post(
        "http://localhost:3000/api/v2/automations",
        async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            { automation: baseAutomation([]) },
            { status: 201 },
          );
        },
      ),
    );

    await createCommand.parseAsync([
      "node",
      "cli",
      "-n",
      "alerts",
      "--agent",
      "my-agent",
      "-p",
      "Summarize alerts",
    ]);

    expect(capturedBody).toMatchObject({
      name: "alerts",
      agentId: AGENT_ID,
      instruction: "Summarize alerts",
    });
    expect(capturedBody).not.toHaveProperty("trigger");

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain('Automation "alerts" created');
    expect(logCalls).toContain("zero automation trigger add");
  });

  it("should create with an inline cron trigger (--cron sugar)", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    server.use(
      composeByNameHandler(),
      http.post(
        "http://localhost:3000/api/v2/automations",
        async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            { automation: baseAutomation([cronTrigger]) },
            { status: 201 },
          );
        },
      ),
    );

    await createCommand.parseAsync([
      "node",
      "cli",
      "-n",
      "alerts",
      "--agent",
      "my-agent",
      "-p",
      "Summarize alerts",
      "--cron",
      "0 9 * * *",
      "--timezone",
      "UTC",
    ]);

    expect(capturedBody?.trigger).toEqual({
      kind: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
    });

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain('Automation "alerts" created');
    expect(logCalls).toContain("0 9 * * *");
  });

  it("should create with an inline loop trigger parsing the duration", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    server.use(
      composeByNameHandler(),
      http.post(
        "http://localhost:3000/api/v2/automations",
        async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            { automation: baseAutomation([]) },
            { status: 201 },
          );
        },
      ),
    );

    await createCommand.parseAsync([
      "node",
      "cli",
      "-n",
      "alerts",
      "--agent",
      "my-agent",
      "-p",
      "poll",
      "--loop",
      "15m",
    ]);

    expect(capturedBody?.trigger).toEqual({
      kind: "loop",
      intervalSeconds: 900,
    });
  });

  it("should print the webhook URL and one-time secret with --webhook", async () => {
    server.use(
      composeByNameHandler(),
      http.post("http://localhost:3000/api/v2/automations", () => {
        return HttpResponse.json(
          {
            automation: baseAutomation([webhookTrigger]),
            webhookSecret: "whsec_supersecretvalue",
          },
          { status: 201 },
        );
      }),
    );

    await createCommand.parseAsync([
      "node",
      "cli",
      "-n",
      "alerts",
      "--agent",
      "my-agent",
      "-p",
      "Summarize alerts",
      "--webhook",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(webhookTrigger.webhookUrl);
    expect(logCalls).toContain("whsec_supersecretvalue");
    expect(logCalls).toContain("shown only once");
  });

  it("should reject an invalid --loop duration", async () => {
    await expect(async () => {
      await createCommand.parseAsync([
        "node",
        "cli",
        "-n",
        "alerts",
        "--agent",
        "my-agent",
        "-p",
        "poll",
        "--loop",
        "soon",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Invalid duration: "soon"'),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should reject multiple inline trigger flags", async () => {
    await expect(async () => {
      await createCommand.parseAsync([
        "node",
        "cli",
        "-n",
        "alerts",
        "--agent",
        "my-agent",
        "-p",
        "poll",
        "--cron",
        "0 9 * * *",
        "--webhook",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "Use at most one of --cron, --once, --loop, --webhook",
      ),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should surface API validation errors", async () => {
    server.use(
      composeByNameHandler(),
      http.post("http://localhost:3000/api/v2/automations", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Automation name already exists for this agent",
              code: "BAD_REQUEST",
            },
          },
          { status: 400 },
        );
      }),
    );

    await expect(async () => {
      await createCommand.parseAsync([
        "node",
        "cli",
        "-n",
        "alerts",
        "--agent",
        "my-agent",
        "-p",
        "Summarize alerts",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Automation name already exists for this agent"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
