import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../../mocks/server";
import { generateCommand } from "../index";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";

function connector(
  type: string,
  externalUsername: string | null = `${type}-user`,
) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    type,
    authMethod: "api-token",
    externalId: `${type}-external-id`,
    externalUsername,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "connected",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function stubConnectors(connectors: Array<Record<string, unknown>>) {
  return stubConnectorsWithConfiguredTypes(connectors, [
    "fal",
    "luma",
    "luma-ai",
    "openai",
    "replicate",
    "runway",
  ]);
}

function stubConnectorsWithConfiguredTypes(
  connectors: Array<Record<string, unknown>>,
  configuredTypes: string[],
) {
  return http.get("http://localhost:3000/api/zero/connectors", () => {
    return HttpResponse.json({
      connectors,
      configuredTypes,
      connectorProvidedBindings: [],
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

function stubAvailableConnectors(types: string[]) {
  return http.get("http://localhost:3000/api/zero/connectors/search", () => {
    return HttpResponse.json({
      connectors: types.map((type) => {
        return {
          id: type,
          label: type,
          description: type,
          authMethods: ["api-token"],
        };
      }),
    });
  });
}

describe("zero generate lister", () => {
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
    expect(text).toContain("Connectors:");
    expect(text).toContain("fal");
    expect(text).toContain("fal.ai");
    expect(text).toContain("@fal-user");
    expect(text).toContain("openai");
    expect(text).toContain("OpenAI");
    expect(text).not.toContain("replicate-user");
    expect(text).toContain("Built-in command:");
    expect(text).toContain("vm0");
    expect(text).toContain("Built-in image generation");
    expect(text).toContain(
      "Models: fal.ai: gpt-image-1 (default), gpt-image-2, gpt-image-1.5, gpt-image-1-mini, flux-pro-1.1, flux-pro-1.1-ultra, qwen-image, seedream4, nano-banana-2",
    );
    expect(text).toContain("Use: zero generate image --provider built-in -h");
    expect(text).not.toContain(
      "Use: zero generate image --provider built-in --model",
    );
    expect(text).not.toContain("Model: gpt-image-1.5");
    expect(text).not.toContain("Model: fal-ai/flux-pro/v1.1");
    expect(text).not.toContain("Fallback option:");
    expect(text).not.toContain("Official provider:");
    expect(text).not.toContain("Next actions:");
    expect(text).toContain(
      "Use --all to see every image generation candidate.",
    );
  });

  it("shows not-ready candidates and action links with --all", async () => {
    server.use(
      stubConnectors([
        connector("fal", "fal-user"),
        connector("replicate", "replicate-user"),
        {
          ...connector("openai", "openai-user"),
          connectionStatus: "reconnect-required",
        },
      ]),
      stubUserConnectors(["fal"]),
    );

    await generateCommand.parseAsync(["node", "cli", "image", "--all"]);

    const text = output();
    expect(text).toContain("Other image generation connectors");
    expect(text).toContain("Connectors:");
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
      `[Connect and authorize Luma AI](http://localhost:3000/connectors/luma-ai/connect?agentId=${AGENT_ID})`,
    );
    expect(text).toContain(
      "[Reconnect OpenAI](http://localhost:3000/connectors)",
    );
  });

  it("does not mark runtime-configured but unavailable connectors as connectable", async () => {
    server.use(
      stubConnectorsWithConfiguredTypes([], ["bentoml"]),
      stubAvailableConnectors([]),
      stubUserConnectors([]),
    );

    await generateCommand.parseAsync(["node", "cli", "text", "--all"]);

    const text = output();
    expect(text).toContain("bentoml");
    expect(text).toContain("not available for this account");
    expect(text).not.toContain("/connectors/bentoml");
  });

  it("suggests the built-in video command when no video connector is ready", async () => {
    server.use(
      stubConnectorsWithConfiguredTypes([], ["fal", "luma-ai", "runway"]),
      stubUserConnectors([]),
    );

    await generateCommand.parseAsync(["node", "cli", "video"]);

    const text = output();
    expect(text).toContain("Video generation choices for current agent");
    expect(text).not.toContain("Connectors:");
    expect(text).not.toContain("No ready video generation connectors found.");
    expect(text).toContain("Built-in command:");
    expect(text).toContain("Built-in video generation");
    expect(text).toContain(
      "Models: dreamina-seedance-2.0-fast (default), dreamina-seedance-2.0, seedance-1.5-pro, veo3.1-fast, kling-v3-4k",
    );
    expect(text).toContain("Use: zero generate video --provider built-in -h");
    expect(text).not.toContain(
      "Use: zero generate video --provider built-in --model",
    );
    expect(text).not.toContain("Model: dreamina-seedance-2-0-260128");
    expect(text).not.toContain("Model: seedance-1-5-pro-251215");
    expect(text).not.toContain("Model: seedance-1-0-pro-250528");
    expect(text).not.toContain("Fallback option:");
    expect(text).not.toContain("Official provider:");
    expect(text).not.toContain("Next actions:");
    expect(text).not.toContain(
      "Use --all to see every video generation candidate.",
    );
  });

  it("suggests the built-in presentation command", async () => {
    server.use(
      stubConnectorsWithConfiguredTypes([], []),
      stubUserConnectors([]),
    );

    await generateCommand.parseAsync(["node", "cli", "presentation"]);

    const text = output();
    expect(text).toContain("Presentation generation choices for current agent");
    expect(text).not.toContain("Connectors:");
    expect(text).not.toContain(
      "No ready presentation generation connectors found.",
    );
    expect(text).toContain("Built-in command:");
    expect(text).toContain("Built-in presentation generation");
    expect(text).toContain("Models: gpt-5.5");
    expect(text).toContain("Use: zero generate presentation -h");
    expect(text).not.toContain("Model: gpt-5.5");
    expect(text).not.toContain("Fallback option:");
    expect(text).not.toContain("Official provider:");
  });

  it("suggests the built-in website command", async () => {
    server.use(
      stubConnectorsWithConfiguredTypes([], []),
      stubUserConnectors([]),
    );

    await generateCommand.parseAsync(["node", "cli", "website"]);

    const text = output();
    expect(text).toContain("Website generation choices for current agent");
    expect(text).not.toContain("Connectors:");
    expect(text).not.toContain("No ready website generation connectors found.");
    expect(text).toContain("Built-in command:");
    expect(text).toContain("Built-in website generation");
    expect(text).toContain("Models: gpt-5.5");
    expect(text).toContain("Use: zero generate website -h");
    expect(text).toContain("Context:");
    expect(text).toContain(
      "Standalone static website artifacts can be authored locally and published with zero host for a public URL.",
    );
    expect(text).toContain(
      "zero host is for static directories with index.html; it is not a general deploy system for apps that need a backend, database, worker, or long-running process.",
    );
    expect(text).toContain(
      "Existing web app changes should usually follow the project's own build, test, and deploy workflow.",
    );
    expect(text).not.toContain("Model: gpt-5.5");
    expect(text).not.toContain("Fallback option:");
    expect(text).not.toContain("Official provider:");
  });

  it.each([
    ["report", "Report", "Built-in report generation"],
    ["docs-design", "Docs design", "Built-in docs design generation"],
    ["poster", "Poster", "Built-in poster generation"],
    [
      "dashboard-design",
      "Dashboard design",
      "Built-in dashboard design generation",
    ],
    [
      "mobile-app-design",
      "Mobile app design",
      "Built-in mobile app design generation",
    ],
  ])("suggests the built-in %s command", async (type, label, commandLabel) => {
    server.use(
      stubConnectorsWithConfiguredTypes([], []),
      stubUserConnectors([]),
    );

    await generateCommand.parseAsync(["node", "cli", type]);

    const text = output();
    expect(text).toContain(`${label} generation choices for current agent`);
    expect(text).not.toContain(`No ready ${type} generation connectors found.`);
    expect(text).toContain("Built-in command:");
    expect(text).toContain(commandLabel);
    expect(text).toContain("Models: gpt-5.5");
    expect(text).toContain(`Use: zero generate ${type} -h`);
  });

  it("suggests the built-in voice command when no voice connector is ready", async () => {
    server.use(
      stubConnectorsWithConfiguredTypes(
        [],
        ["elevenlabs", "hume", "minimax", "openai"],
      ),
      stubUserConnectors([]),
    );

    await generateCommand.parseAsync(["node", "cli", "voice"]);

    const text = output();
    expect(text).toContain("Voice generation choices for current agent");
    expect(text).not.toContain("Connectors:");
    expect(text).not.toContain("No ready voice generation connectors found.");
    expect(text).toContain("Built-in command:");
    expect(text).toContain("Built-in voice generation");
    expect(text).toContain("Models: gpt-4o-mini-tts");
    expect(text).toContain("Use: zero generate voice --provider built-in -h");
    expect(text).not.toContain("Model: gpt-4o-mini-tts");
    expect(text).not.toContain("Fallback option:");
    expect(text).not.toContain("Official provider:");
    expect(text).not.toContain("Next actions:");
    expect(text).not.toContain(
      'zero generate voice --provider built-in --text "Hello"',
    );
  });

  it("also shows the built-in voice provider when a voice connector is ready", async () => {
    server.use(
      stubConnectorsWithConfiguredTypes(
        [connector("openai", "openai-user")],
        ["elevenlabs", "hume", "minimax", "openai"],
      ),
      stubUserConnectors(["openai"]),
    );

    await generateCommand.parseAsync(["node", "cli", "voice"]);

    const text = output();
    expect(text).toContain("Voice generation choices for current agent");
    expect(text).toContain("Connectors:");
    expect(text).toContain("OpenAI");
    expect(text).toContain("@openai-user");
    expect(text).toContain("Built-in command:");
    expect(text).toContain("Built-in voice generation");
    expect(text).toContain("Models: gpt-4o-mini-tts");
    expect(text).toContain("Use: zero generate voice --provider built-in -h");
    expect(text).not.toContain("Model: gpt-4o-mini-tts");
  });

  it("lists music as the public audio connector-backed subtype", async () => {
    server.use(
      stubConnectorsWithConfiguredTypes(
        [connector("elevenlabs", "elevenlabs-user")],
        ["elevenlabs", "minimax"],
      ),
      stubUserConnectors(["elevenlabs"]),
    );

    await generateCommand.parseAsync(["node", "cli", "music"]);

    const text = output();
    expect(text).toContain("Music generation choices for current agent");
    expect(text).toContain("Connectors:");
    expect(text).toContain("ElevenLabs");
    expect(text).toContain("@elevenlabs-user");
    expect(text).not.toContain("Built-in command:");
  });

  it("rejects unknown generation types via Commander", async () => {
    await expect(
      generateCommand.parseAsync(["node", "cli", "spaceship"]),
    ).rejects.toThrow();
    await expect(
      generateCommand.parseAsync(["node", "cli", "audio"]),
    ).rejects.toThrow();
  });
});
