import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../../mocks/server";
import {
  getModelSwitchGuidance,
  switchCommand,
  zeroModelCommand,
} from "../index";

const MODEL_POLICIES_RESPONSE = {
  workspaceDefaultModel: "claude-sonnet-4-6",
  workspaceDefaultPolicyId: "00000000-0000-4000-8000-000000000001",
  policies: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      model: "claude-sonnet-4-6",
      modelLabel: "Claude Sonnet 4.6",
      isDefault: true,
      defaultProviderType: "vm0",
      credentialScope: "org",
      modelProviderId: null,
      routeStatus: "valid",
      routeStatusReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      model: "gpt-5.5",
      modelLabel: "GPT-5.5",
      isDefault: false,
      defaultProviderType: "openai-api-key",
      credentialScope: "org",
      modelProviderId: "00000000-0000-4000-8000-000000000102",
      routeStatus: "valid",
      routeStatusReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

describe("zero model command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    mockConsoleLog.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should expose model discovery and switching subcommands", () => {
    expect(zeroModelCommand.name()).toBe("model");
    expect(zeroModelCommand.description()).toBe(
      "List available models and model-switching guidance",
    );
    expect(
      zeroModelCommand.commands.map((command) => {
        return command.name();
      }),
    ).toEqual(["list", "switch"]);
  });

  it("should list allowed models, providers, and built-in price coefficients", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/model-policies", () => {
        return HttpResponse.json(MODEL_POLICIES_RESPONSE);
      }),
    );

    await zeroModelCommand.parseAsync(["node", "cli", "ls"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Allowed Models:");
    expect(logCalls).toContain("Claude Sonnet 4.6");
    expect(logCalls).toContain("provider: built-in");
    expect(logCalls).toContain("price coefficient: x1");
    expect(logCalls).toContain("GPT-5.5");
    expect(logCalls).toContain("provider: api key");
    expect(logCalls).not.toContain("price coefficient: x2");
    expect(logCalls).toContain("zero model-provider set --help");
  });

  it("should point web users at the input-side model selector", async () => {
    vi.stubEnv(
      "VM0_APPEND_SYSTEM_PROMPT",
      "You are currently running inside: Web\n\nYou are communicating with the user through the web chat UI.",
    );

    await switchCommand.parseAsync(["node", "cli"]);

    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "model selector next to the input box in the web chat",
    );
  });

  it("should point Telegram users at /model", async () => {
    vi.stubEnv(
      "VM0_APPEND_SYSTEM_PROMPT",
      "You are currently running inside: Telegram",
    );

    await switchCommand.parseAsync(["node", "cli"]);

    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Use /model in Telegram",
    );
  });

  it("should point other environments at app.vm0.ai", () => {
    expect(getModelSwitchGuidance("schedule")).toContain(
      "Open https://app.vm0.ai",
    );
  });
});
