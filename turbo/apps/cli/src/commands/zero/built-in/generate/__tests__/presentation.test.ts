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
  imageCount: 3,
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
          imageCount: 3,
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
      "3",
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
    expect(stdout).toContain("Images: 3");
    expect(stdout).toContain("Style: swiss");
    expect(stdout).toContain("Theme: ikb");
    expect(stdout).toContain("Credits charged: 31");
    expect(stdout).toContain("Text credits: 24");
    expect(stdout).toContain("Image credits: 7");
    expect(stdout).toContain("Model: gpt-5.5");
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
      imageCount: 3,
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
