import { describe, it, expect, vi } from "vitest";
import { HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { http } from "../../../../__tests__/msw";
import { reloadEnv } from "../../../../env";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function openRouterResponse(content: string | null) {
  return {
    choices: [{ message: { content } }],
  };
}

describe("generateChatTitle", () => {
  it("should return null when OPENROUTER_API_KEY is not configured", async () => {
    // OPENROUTER_API_KEY is not stubbed by default in test setup
    const { generateChatTitle } = await import("../lightweight-model");

    const result = await generateChatTitle("Hello, how are you?");

    expect(result).toBeNull();
  });

  it("should return a title on successful response", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse("Project Setup Help"));
    });
    server.use(handler.handler);

    const { generateChatTitle } = await import("../lightweight-model");

    const result = await generateChatTitle("Help me set up my project");

    expect(result).toBe("Project Setup Help");
    expect(handler.mocked).toHaveBeenCalledTimes(1);
  });

  it("should trim whitespace from returned content", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse("  Padded Title  "));
    });
    server.use(handler.handler);

    const { generateChatTitle } = await import("../lightweight-model");

    const result = await generateChatTitle("Some user message");

    expect(result).toBe("Padded Title");
  });

  it("should throw when response content is empty", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse(""));
    });
    server.use(handler.handler);

    const { generateChatTitle } = await import("../lightweight-model");

    await expect(generateChatTitle("Hello")).rejects.toThrow(
      "OpenRouter returned empty content",
    );
    expect(handler.mocked).toHaveBeenCalledTimes(1);
  });

  it("should throw when response content is null", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json({ choices: [{ message: {} }] });
    });
    server.use(handler.handler);

    const { generateChatTitle } = await import("../lightweight-model");

    await expect(generateChatTitle("Hello")).rejects.toThrow(
      "OpenRouter returned empty content",
    );
  });

  it.each([
    ["**Bold** and `code` title", "Bold and code title"],
    ["## Chat Title Here", "Chat Title Here"],
    ["*Italic* setup guide", "Italic setup guide"],
    ["__underscored__ text", "underscored text"],
    ["[Click here](https://example.com) for help", "Click here for help"],
    ["# **Bold Heading** with `code`", "Bold Heading with code"],
    ["Plain text without markdown", "Plain text without markdown"],
  ])("should strip markdown from %j → %j", async (raw, expected) => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse(raw));
    });
    server.use(handler.handler);

    const { generateChatTitle } = await import("../lightweight-model");

    expect(await generateChatTitle("msg")).toBe(expected);
  });

  it("should throw on HTTP error", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.text("rate limited", { status: 429 });
    });
    server.use(handler.handler);

    const { generateChatTitle } = await import("../lightweight-model");

    await expect(generateChatTitle("Hello")).rejects.toThrow(
      "OpenRouter request failed: 429",
    );
  });

  it("should include previous context when provided", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    let capturedBody: unknown;
    const handler = http.post(OPENROUTER_URL, async ({ request }) => {
      capturedBody = await request.json();
      return HttpResponse.json(openRouterResponse("Debugging Help"));
    });
    server.use(handler.handler);

    const { generateChatTitle } = await import("../lightweight-model");

    await generateChatTitle("Fix my bug", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi, how can I help?" },
    ]);

    const body = capturedBody as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]!.content).toContain("Previous conversation:");
    expect(body.messages[1]!.content).toContain("Current message: Fix my bug");
  });

  it("should strip surrounding quotes from title", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse('"Some Quoted Title"'));
    });
    server.use(handler.handler);

    const { generateChatTitle } = await import("../lightweight-model");

    expect(await generateChatTitle("msg")).toBe("Some Quoted Title");
  });

  it("should strip horizontal rules from title", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse("---\nSome Title"));
    });
    server.use(handler.handler);

    const { generateChatTitle } = await import("../lightweight-model");

    expect(await generateChatTitle("msg")).toBe("Some Title");
  });
});

describe("generateRunSummary", () => {
  it("should return null when OPENROUTER_API_KEY is not configured", async () => {
    const { generateRunSummary } = await import("../lightweight-model");

    const result = await generateRunSummary("chat", "hello", "world");

    expect(result).toBeNull();
  });

  it("should return a summary on successful response", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(
        openRouterResponse(
          "User asked about project setup. Agent provided step-by-step instructions.",
        ),
      );
    });
    server.use(handler.handler);

    const { generateRunSummary } = await import("../lightweight-model");

    const result = await generateRunSummary(
      "chat",
      "How do I set up this project?",
      "First install dependencies with pnpm install, then run pnpm dev.",
    );

    expect(result).toBe(
      "User asked about project setup. Agent provided step-by-step instructions.",
    );
    expect(handler.mocked).toHaveBeenCalledTimes(1);
  });

  it("should include triggerSource in the system prompt", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    let capturedBody: unknown;
    const handler = http.post(OPENROUTER_URL, async ({ request }) => {
      capturedBody = await request.json();
      return HttpResponse.json(openRouterResponse("Summary text"));
    });
    server.use(handler.handler);

    const { generateRunSummary } = await import("../lightweight-model");

    await generateRunSummary("slack", "prompt", "result");

    const body = capturedBody as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]!.content).toContain("slack");
  });

  it("should truncate long input to 3 lines of 80 chars each", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    let capturedBody: unknown;
    const handler = http.post(OPENROUTER_URL, async ({ request }) => {
      capturedBody = await request.json();
      return HttpResponse.json(openRouterResponse("Summary"));
    });
    server.use(handler.handler);

    const { generateRunSummary } = await import("../lightweight-model");

    const longLine = "x".repeat(200);
    const manyLines = Array.from({ length: 10 }, (_, i) => {
      return `Line ${i}`;
    }).join("\n");

    await generateRunSummary("chat", longLine, manyLines);

    const body = capturedBody as {
      messages: Array<{ role: string; content: string }>;
    };
    const userContent = body.messages[1]!.content;

    // Prompt should be truncated to 80 chars + ellipsis (single line)
    expect(userContent).toContain("x".repeat(80) + "…");
    expect(userContent).not.toContain("x".repeat(81));

    // Result should only have first 3 lines
    expect(userContent).toContain("Line 0");
    expect(userContent).toContain("Line 2");
    expect(userContent).not.toContain("Line 3");
  });
});

describe("generateScheduleDescription", () => {
  it("should return a description on successful response", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(
        openRouterResponse("Runs daily backup for production database"),
      );
    });
    server.use(handler.handler);

    const { generateScheduleDescription } =
      await import("../lightweight-model");

    const result = await generateScheduleDescription(
      "BackupBot",
      "Daily Backup",
      "Every day at 2am",
      "Back up the production database",
    );

    expect(result).toBe("Runs daily backup for production database");
    expect(handler.mocked).toHaveBeenCalledTimes(1);
  });

  it("should strip markdown from schedule descriptions", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(
        openRouterResponse("**Daily** `backup` for [prod](https://db.io)"),
      );
    });
    server.use(handler.handler);

    const { generateScheduleDescription } =
      await import("../lightweight-model");

    const result = await generateScheduleDescription(
      "BackupBot",
      "Daily Backup",
      "Every day at 2am",
      "Back up the production database",
    );

    expect(result).toBe("Daily backup for prod");
  });
});
