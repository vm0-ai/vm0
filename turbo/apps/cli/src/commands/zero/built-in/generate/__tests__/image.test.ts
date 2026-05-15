/**
 * Tests for zero built-in generate image command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend image route via MSW
 * - Real (internal): All CLI code and fetch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../../../mocks/server";
import { zeroBuiltInCommand } from "../../index";
import { imageCommand } from "../image";

const IMAGE_URL = "http://localhost:3000/api/zero/image-io/generate";
const IMAGE_GENERATION_ID = "00000000-0000-4000-8000-000000000001";
const IMAGE_STATUS_URL = `http://localhost:3000/api/zero/built-in-generations/${IMAGE_GENERATION_ID}`;
const IMAGE_RESULT = {
  id: "image-file-id",
  filename: "image-image-fi.png",
  contentType: "image/png",
  size: 19,
  url: "http://localhost:3000/f/user-1/image-file-id/image-image-fi.png",
  creditsCharged: 65,
  model: "gpt-image-1",
  provider: "openai",
  imageSize: "1024x1024",
  quality: "medium",
  background: "opaque",
  outputFormat: "png",
  moderation: "auto",
  usage: {
    textInputTokens: 1000,
    imageInputTokens: 0,
    imageOutputTokens: 2000,
    totalTokens: 3000,
  },
};

describe("zero built-in generate image command", () => {
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
    vi.stubEnv("ZERO_TOKEN", "test-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("should generate an image and print the /f file URL", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(IMAGE_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.headers.get("content-type")).toBe("application/json");
        capturedBody = await request.json();

        return HttpResponse.json({
          ...IMAGE_RESULT,
          imageSize: "1024x1024",
          quality: "auto",
          background: "opaque",
          outputFormat: "webp",
          outputCompression: 50,
          moderation: "low",
        });
      }),
    );

    await zeroBuiltInCommand.parseAsync([
      "node",
      "cli",
      "generate",
      "image",
      "--prompt",
      "A watercolor fox",
      "--quality",
      "auto",
      "--background",
      "opaque",
      "--format",
      "webp",
      "--compression",
      "50",
      "--moderation",
      "low",
    ]);

    expect(capturedBody).toEqual({
      prompt: "A watercolor fox",
      model: "gpt-image-1",
      size: "1024x1024",
      quality: "auto",
      background: "opaque",
      outputFormat: "webp",
      outputCompression: 50,
      moderation: "low",
      safetyTolerance: "4",
    });
    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(`Image generated: ${IMAGE_RESULT.url}`);
    expect(stdout).toContain(`File: ${IMAGE_RESULT.filename}`);
    expect(stdout).toContain("Size: 1024x1024");
    expect(stdout).toContain("Quality: auto");
    expect(stdout).toContain("Format: webp");
    expect(stdout).toContain("Compression: 50");
    expect(stdout).toContain("Moderation: low");
    expect(stdout).toContain("Credits charged: 65");
    expect(stdout).toContain("Model: gpt-image-1");
    expect(stdout).toContain("Provider: openai");
  });

  it("should pass fal model controls to the image API", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(IMAGE_URL, async ({ request }) => {
        capturedBody = await request.json();

        return HttpResponse.json({
          ...IMAGE_RESULT,
          model: "fal-ai/flux-pro/v1.1",
          provider: "fal",
          quality: "model-default",
          billingCategory: "output_megapixel",
          billingQuantity: 2,
          safetyTolerance: "5",
          seed: 123,
          usage: undefined,
        });
      }),
    );

    await zeroBuiltInCommand.parseAsync([
      "node",
      "cli",
      "generate",
      "image",
      "--model",
      "flux-pro-1.1",
      "--prompt",
      "A product hero shot",
      "--format",
      "jpeg",
      "--seed",
      "123",
      "--safety-tolerance",
      "5",
      "--enhance-prompt",
    ]);

    expect(capturedBody).toEqual({
      prompt: "A product hero shot",
      model: "flux-pro-1.1",
      size: "1024x1024",
      quality: "medium",
      background: "auto",
      outputFormat: "jpeg",
      moderation: "auto",
      seed: 123,
      safetyTolerance: "5",
      enhancePrompt: true,
    });
    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("Safety tolerance: 5");
    expect(stdout).toContain("Seed: 123");
    expect(stdout).toContain("Model: fal-ai/flux-pro/v1.1");
    expect(stdout).toContain("Provider: fal");
  });

  it("should print JSON metadata when --json is provided", async () => {
    server.use(
      http.post(IMAGE_URL, () => {
        return HttpResponse.json(IMAGE_RESULT);
      }),
    );

    await zeroBuiltInCommand.parseAsync([
      "node",
      "cli",
      "generate",
      "image",
      "--prompt",
      "JSON please",
      "--json",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      id: IMAGE_RESULT.id,
      filename: IMAGE_RESULT.filename,
      contentType: "image/png",
      size: IMAGE_RESULT.size,
      url: IMAGE_RESULT.url,
      creditsCharged: 65,
      model: IMAGE_RESULT.model,
      provider: "openai",
      imageSize: "1024x1024",
      quality: "medium",
      outputFormat: "png",
      moderation: "auto",
    });
  });

  it("should wait for an accepted async generation result", async () => {
    let statusRequested = false;
    server.use(
      http.post(IMAGE_URL, () => {
        return HttpResponse.json(
          {
            generationId: IMAGE_GENERATION_ID,
            type: "image",
            status: "queued",
            realtime: {
              channelName: "user:user-1",
              eventName: `built-in-generation:${IMAGE_GENERATION_ID}`,
              tokenRequest: {
                keyName: "test-key",
                timestamp: 1_700_000_000_000,
                capability: '{"user:user-1":["subscribe"]}',
                clientId: "user-1",
                nonce: "test-nonce",
                mac: "test-mac",
              },
            },
          },
          { status: 202 },
        );
      }),
      http.get(IMAGE_STATUS_URL, ({ request }) => {
        statusRequested = true;
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({
          generationId: IMAGE_GENERATION_ID,
          type: "image",
          status: "completed",
          result: IMAGE_RESULT,
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
      "image",
      "--prompt",
      "Async please",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(statusRequested).toBe(true);
    expect(stdout).toContain(`Image generated: ${IMAGE_RESULT.url}`);
  });

  it("should describe image generation model capabilities in help", () => {
    let helpOutput = "";
    imageCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    imageCommand.outputHelp();

    expect(helpOutput).toContain("gpt-image-1.5");
    expect(helpOutput).toContain("gpt-image-1 (default)");
    expect(helpOutput).toContain("flux-pro-1.1");
    expect(helpOutput).toContain("qwen-image");
    expect(helpOutput).toContain("support varies");
    expect(helpOutput).toContain("3840x2160");
    expect(helpOutput).toContain("edges divisible by 16");
    expect(helpOutput).toContain("--compression 0-100");
    expect(helpOutput).toContain("Moderation: auto or low");
    expect(helpOutput).toContain("--seed");
    expect(helpOutput).toContain("--safety-tolerance");
    expect(helpOutput).toContain("not support transparent");
    expect(helpOutput).toContain("backgrounds");
    expect(helpOutput).toContain("image edits, reference images, masks");
  });

  it("should surface API errors", async () => {
    server.use(
      http.post(IMAGE_URL, () => {
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
        "image",
        "--prompt",
        "hello",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Credits depleted"),
    );
  });
});
