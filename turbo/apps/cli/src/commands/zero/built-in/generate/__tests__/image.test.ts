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

const IMAGE_URL = "http://localhost:3000/api/zero/image-io/generate";
const IMAGE_RESULT = {
  id: "image-file-id",
  filename: "image-image-fi.png",
  contentType: "image/png",
  size: 19,
  url: "http://localhost:3000/f/user-1/image-file-id/image-image-fi.png",
  creditsCharged: 65,
  model: "gpt-image-2",
  imageSize: "1024x1024",
  quality: "medium",
  background: "opaque",
  outputFormat: "png",
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
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("should generate an image and print the /f file URL", async () => {
    server.use(
      http.post(IMAGE_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.headers.get("content-type")).toBe("application/json");
        expect(await request.json()).toEqual({
          prompt: "A watercolor fox",
          size: "1024x1536",
          quality: "high",
          background: "transparent",
          outputFormat: "webp",
        });

        return HttpResponse.json({
          ...IMAGE_RESULT,
          imageSize: "1024x1536",
          quality: "high",
          background: "transparent",
          outputFormat: "webp",
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
      "--size",
      "1024x1536",
      "--quality",
      "high",
      "--background",
      "transparent",
      "--format",
      "webp",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(`Image generated: ${IMAGE_RESULT.url}`);
    expect(stdout).toContain(`File: ${IMAGE_RESULT.filename}`);
    expect(stdout).toContain("Size: 1024x1536");
    expect(stdout).toContain("Quality: high");
    expect(stdout).toContain("Format: webp");
    expect(stdout).toContain("Credits charged: 65");
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
      model: "gpt-image-2",
      imageSize: "1024x1024",
      quality: "medium",
      outputFormat: "png",
    });
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
