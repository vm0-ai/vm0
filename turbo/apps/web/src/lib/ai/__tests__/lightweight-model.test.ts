import { describe, it, expect, vi } from "vitest";
import { HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { http } from "../../../__tests__/msw";
import { reloadEnv } from "../../../env";

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

  it("should include assistant message when provided", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    let capturedBody: unknown;
    const handler = http.post(OPENROUTER_URL, async ({ request }) => {
      capturedBody = await request.json();
      return HttpResponse.json(openRouterResponse("Debugging Help"));
    });
    server.use(handler.handler);

    const { generateChatTitle } = await import("../lightweight-model");

    await generateChatTitle("Fix my bug", "Here is the solution");

    const body = capturedBody as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages).toHaveLength(3);
    expect(body.messages[2]).toEqual({
      role: "assistant",
      content: "Here is the solution",
    });
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

    const { generateScheduleDescription } = await import(
      "../lightweight-model"
    );

    const result = await generateScheduleDescription(
      "BackupBot",
      "Daily Backup",
      "Every day at 2am",
      "Back up the production database",
    );

    expect(result).toBe("Runs daily backup for production database");
    expect(handler.mocked).toHaveBeenCalledTimes(1);
  });
});
