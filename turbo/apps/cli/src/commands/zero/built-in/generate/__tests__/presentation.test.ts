/**
 * Tests for zero built-in generate presentation command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend presentation route via MSW
 * - Real (internal): All CLI code and fetch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../../../mocks/server";
import { zeroBuiltInCommand } from "../../index";

const PRESENTATION_URL =
  "http://localhost:3000/api/zero/presentation-io/generate";
const PRESENTATION_GENERATION_ID = "11111111-1111-4111-8111-111111111111";
const PRESENTATION_STATUS_URL = `http://localhost:3000/api/zero/built-in-generations/${PRESENTATION_GENERATION_ID}`;
const PRESENTATION_RESULT = {
  id: "presentation-file-id",
  filename: "presentation-present.html",
  contentType: "text/html",
  size: 4096,
  url: "http://localhost:3000/f/user-1/presentation-file-id/presentation-present.html",
  creditsCharged: 31,
  model: "gpt-5.5",
  style: "swiss",
  theme: "ikb",
  slideCount: 10,
  imageCount: 8,
  imageModel: "gpt-image-1.5",
  imageUrls: ["http://localhost:3000/f/user-1/image-file-id/image-visual.webp"],
  imageCreditsCharged: 7,
  textCreditsCharged: 24,
  title: "API Migration Plan",
  responseId: "resp_presentation",
  usage: {
    inputTokens: 1800,
    outputTokens: 620,
    totalTokens: 2420,
  },
};

describe("zero built-in generate presentation command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
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
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("should generate a presentation and print the /f HTML URL", async () => {
    server.use(
      http.post(PRESENTATION_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.headers.get("content-type")).toBe("application/json");
        expect(await request.json()).toEqual({
          prompt: "API migration plan",
          style: "swiss",
          slideCount: 10,
          imageCount: 8,
          imageModel: "gpt-image-1.5",
          theme: "ikb",
          audience: "engineering leadership",
          title: "API Migration Plan",
        });

        return HttpResponse.json(PRESENTATION_RESULT);
      }),
    );

    await zeroBuiltInCommand.parseAsync([
      "node",
      "cli",
      "generate",
      "presentation",
      "--prompt",
      "API migration plan",
      "--style",
      "swiss",
      "--slides",
      "10",
      "--images",
      "8",
      "--image-model",
      "gpt-image-1.5",
      "--theme",
      "ikb",
      "--audience",
      "engineering leadership",
      "--title",
      "API Migration Plan",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      `Presentation generated: ${PRESENTATION_RESULT.url}`,
    );
    expect(stdout).toContain(`File: ${PRESENTATION_RESULT.filename}`);
    expect(stdout).toContain("Title: API Migration Plan");
    expect(stdout).toContain("Slides: 10");
    expect(stdout).toContain("Images: 8");
    expect(stdout).toContain("Image model: gpt-image-1.5");
    expect(stdout).toContain("Style: swiss");
    expect(stdout).toContain("Theme: ikb");
    expect(stdout).toContain("Credits charged: 31");
    expect(stdout).toContain("Text credits: 24");
    expect(stdout).toContain("Image credits: 7");
    expect(stdout).toContain("Model: gpt-5.5");
  });

  it("should wait for an accepted presentation even when the proxy returns 200", async () => {
    let statusRequested = false;
    server.use(
      http.post(PRESENTATION_URL, () => {
        return HttpResponse.json({
          generationId: PRESENTATION_GENERATION_ID,
          type: "presentation",
          status: "queued",
          realtime: {
            channelName: "user:user-1",
            eventName: `built-in-generation:${PRESENTATION_GENERATION_ID}`,
            tokenRequest: {
              keyName: "test-key",
              timestamp: 1_700_000_000_000,
              capability: '{"user:user-1":["subscribe"]}',
              clientId: "user-1",
              nonce: "test-nonce",
              mac: "test-mac",
            },
          },
        });
      }),
      http.get(PRESENTATION_STATUS_URL, ({ request }) => {
        statusRequested = true;
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({
          generationId: PRESENTATION_GENERATION_ID,
          type: "presentation",
          status: "completed",
          result: PRESENTATION_RESULT,
          createdAt: "2026-05-15T00:00:00.000Z",
          startedAt: "2026-05-15T00:00:01.000Z",
          completedAt: "2026-05-15T00:00:02.000Z",
        });
      }),
    );

    await zeroBuiltInCommand.parseAsync([
      "node",
      "cli",
      "generate",
      "presentation",
      "--prompt",
      "Async please",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(statusRequested).toBe(true);
    expect(stdout).toContain(
      `Presentation generated: ${PRESENTATION_RESULT.url}`,
    );
    expect(stdout).not.toContain("undefined");
  });

  it("should print JSON metadata when --json is provided", async () => {
    server.use(
      http.post(PRESENTATION_URL, () => {
        return HttpResponse.json(PRESENTATION_RESULT);
      }),
    );

    await zeroBuiltInCommand.parseAsync([
      "node",
      "cli",
      "generate",
      "presentation",
      "--prompt",
      "JSON please",
      "--json",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      id: PRESENTATION_RESULT.id,
      filename: PRESENTATION_RESULT.filename,
      contentType: "text/html",
      size: PRESENTATION_RESULT.size,
      url: PRESENTATION_RESULT.url,
      creditsCharged: 31,
      model: "gpt-5.5",
      style: "swiss",
      theme: "ikb",
      slideCount: 10,
      imageCount: 8,
      imageModel: "gpt-image-1.5",
      imageUrls: PRESENTATION_RESULT.imageUrls,
      imageCreditsCharged: 7,
      textCreditsCharged: 24,
      title: "API Migration Plan",
    });
  });

  it("should surface API errors", async () => {
    server.use(
      http.post(PRESENTATION_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: "Not enough credits",
              code: "INSUFFICIENT_CREDITS",
            },
          },
          { status: 402 },
        );
      }),
    );

    await expect(async () => {
      await zeroBuiltInCommand.parseAsync([
        "node",
        "cli",
        "generate",
        "presentation",
        "--prompt",
        "hello",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Credits depleted"),
    );
  });
});
