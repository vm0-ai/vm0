import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../../mocks/server";
import { generateCommand } from "../generate";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";

function connector(
  type: string,
  externalUsername: string | null = `${type}-user`,
) {
  return {
    id: null,
    type,
    authMethod: "api-token",
    externalId: `${type}-external-id`,
    externalUsername,
    externalEmail: null,
    oauthScopes: null,
    needsReconnect: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function stubConnectors(connectors: Array<Record<string, unknown>>) {
  return http.get("http://localhost:3000/api/zero/connectors", () => {
    return HttpResponse.json({
      connectors,
      configuredTypes: ["fal", "luma", "openai", "replicate", "runway"],
      connectorProvidedSecretNames: [],
    });
  });
}

function stubUserConnectors(enabledTypes: string[]) {
  return http.get(
    `http://localhost:3000/api/zero/agents/${AGENT_ID}/user-connectors`,
    () => {
      return HttpResponse.json({ enabledTypes });
    },
  );
}

describe("zero doctor generate command", () => {
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
    vi.stubEnv("ZERO_AGENT_ID", AGENT_ID);
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  function output(): string {
    return mockConsoleLog.mock.calls.flat().join("\n");
  }

  function errors(): string {
    return mockConsoleError.mock.calls.flat().join("\n");
  }

  it("lists ready image generation connectors for the current agent", async () => {
    server.use(
      stubConnectors([
        connector("fal", "fal-user"),
        connector("openai", "openai-user"),
        connector("replicate", "replicate-user"),
      ]),
      stubUserConnectors(["fal", "openai"]),
    );

    await generateCommand.parseAsync(["node", "cli", "image"]);

    const text = output();
    expect(text).toContain("Image generation choices for current agent");
    expect(text).toContain(`Agent:    ${AGENT_ID}`);
    expect(text).toContain("fal");
    expect(text).toContain("fal.ai");
    expect(text).toContain("@fal-user");
    expect(text).toContain("openai");
    expect(text).toContain("OpenAI");
    expect(text).not.toContain("replicate-user");
    expect(text).toContain(
      "Use --all to see every image generation candidate.",
    );
  });

  it("shows not-ready candidates and action links with --all", async () => {
    server.use(
      stubConnectors([
        connector("fal", "fal-user"),
        connector("replicate", "replicate-user"),
        { ...connector("openai", "openai-user"), needsReconnect: true },
      ]),
      stubUserConnectors(["fal"]),
    );

    await generateCommand.parseAsync(["node", "cli", "image", "--all"]);

    const text = output();
    expect(text).toContain("Other image generation connectors");
    expect(text).toContain("Replicate");
    expect(text).toContain("connected, not authorized for current agent");
    expect(text).toContain("Luma AI");
    expect(text).toContain("not connected or authorized for current agent");
    expect(text).toContain("OpenAI");
    expect(text).toContain("connected, reconnect required");
    expect(text).toContain(
      `[Authorize Replicate](http://localhost:3000/connectors/replicate/authorize?agentId=${AGENT_ID})`,
    );
    expect(text).toContain(
      `[Connect and authorize Luma AI](http://localhost:3000/connectors/luma/authorize?agentId=${AGENT_ID})`,
    );
    expect(text).toContain(
      "[Reconnect OpenAI](http://localhost:3000/connectors)",
    );
  });

  it("outputs machine-readable JSON", async () => {
    server.use(
      stubConnectors([connector("fal", "fal-user"), connector("replicate")]),
      stubUserConnectors(["fal"]),
    );

    await generateCommand.parseAsync(["node", "cli", "image", "--json"]);

    const json = JSON.parse(output()) as {
      generationType: string;
      agentId: string;
      choices: Array<{ type: string; status: string }>;
      otherCandidates: Array<{ type: string; status: string }>;
    };
    expect(json.generationType).toBe("image");
    expect(json.agentId).toBe(AGENT_ID);
    expect(json.choices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "fal", status: "ready" }),
      ]),
    );
    expect(json.otherCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "replicate",
          status: "not-authorized",
        }),
      ]),
    );
  });

  it("rejects unknown generation types with available type guidance", async () => {
    await expect(
      generateCommand.parseAsync(["node", "cli", "spaceship"]),
    ).rejects.toThrow("process.exit called");

    expect(errors()).toContain("Unknown generation type: spaceship");
    expect(errors()).toContain("Available types:");
    expect(errors()).toContain("image");
    expect(errors()).toContain("video");
  });
});
