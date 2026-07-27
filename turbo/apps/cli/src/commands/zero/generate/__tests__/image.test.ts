/**
 * Tests for zero generate image command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend image route via MSW
 * - Real (internal): All CLI code and fetch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../../mocks/server";
import { generateCommand } from "../index";
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
  provider: "fal",
  imageSize: "1024x1024",
  quality: "medium",
  background: "opaque",
  outputFormat: "png",
  moderation: "auto",
};

describe("zero generate image command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
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

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--raw-prompt",
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
    expect(stdout).toContain("Provider: fal");
  });

  it("should print the complete image result as one JSON object", async () => {
    server.use(
      http.post(IMAGE_URL, () => {
        return HttpResponse.json(IMAGE_RESULT);
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--raw-prompt",
      "A watercolor fox",
      "--json",
    ]);

    expect(mockConsoleLog.mock.calls).toEqual([[JSON.stringify(IMAGE_RESULT)]]);
  });

  it.each([
    ["provider listing", ["image", "--json"]],
    ["connector guidance", ["image", "--provider", "replicate", "--json"]],
    [
      "prompt compilation",
      [
        "image",
        "--style",
        "image-style:ink-storefront",
        "--prompt",
        "A florist named Luna Floral",
        "--compile",
        "--json",
      ],
    ],
  ])("should reject JSON output for %s", async (_mode, args) => {
    await expect(async () => {
      await generateCommand.parseAsync(["node", "cli", ...args]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "--json is only available for direct built-in generation",
      ),
    );
    expect(mockConsoleLog).not.toHaveBeenCalled();
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
        });
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--raw-prompt",
      "A product hero shot",
      "--model",
      "flux-pro-1.1",
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

  it("should pass image-to-image controls to the image API", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(IMAGE_URL, async ({ request }) => {
        capturedBody = await request.json();

        return HttpResponse.json({
          ...IMAGE_RESULT,
          model: "fal-ai/flux-pro/v1.1",
          provider: "fal",
          outputFormat: "jpeg",
          sourceImageUrls: ["https://example.com/mockup.png"],
          imagePromptStrength: 0.2,
        });
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--compiled-prompt",
      "Turn this mockup into a polished product shot",
      "--model",
      "flux-pro-1.1",
      "--image-url",
      "https://example.com/mockup.png",
      "--image-prompt-strength",
      "0.2",
      "--format",
      "jpeg",
    ]);

    expect(capturedBody).toEqual({
      prompt: "Turn this mockup into a polished product shot",
      model: "flux-pro-1.1",
      size: "auto",
      quality: "medium",
      background: "auto",
      outputFormat: "jpeg",
      moderation: "auto",
      safetyTolerance: "4",
      imageUrls: ["https://example.com/mockup.png"],
      imagePromptStrength: 0.2,
    });
    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("Model: fal-ai/flux-pro/v1.1");
    expect(stdout).toContain("Provider: fal");
  });

  it("should pass Nano Banana 2 edit controls to the image API", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(IMAGE_URL, async ({ request }) => {
        capturedBody = await request.json();

        return HttpResponse.json({
          ...IMAGE_RESULT,
          model: "fal-ai/nano-banana-2",
          provider: "fal",
          outputFormat: "webp",
          sourceImageUrls: [
            "https://example.com/reference-1.png",
            "https://example.com/reference-2.png",
          ],
        });
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--compiled-prompt",
      "Combine these references into a campaign image",
      "--model",
      "nano-banana-2",
      "--image-url",
      "https://example.com/reference-1.png",
      "--image-url",
      "https://example.com/reference-2.png",
      "--format",
      "webp",
      "--seed",
      "456",
      "--safety-tolerance",
      "5",
    ]);

    expect(capturedBody).toEqual({
      prompt: "Combine these references into a campaign image",
      model: "nano-banana-2",
      size: "auto",
      quality: "medium",
      background: "auto",
      outputFormat: "webp",
      moderation: "auto",
      seed: 456,
      safetyTolerance: "5",
      imageUrls: [
        "https://example.com/reference-1.png",
        "https://example.com/reference-2.png",
      ],
    });
    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("Model: fal-ai/nano-banana-2");
    expect(stdout).toContain("Provider: fal");
  });

  it("should print styled image prompt compilation instructions with --style and --compile", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--style",
      "image-style:ink-storefront",
      "--prompt",
      "A florist named Luna Floral",
      "--compile",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "# Zero generate image prompt compile image-style:ink-storefront",
    );
    expect(stdout).toContain("image prompt-compilation packet");
    expect(stdout).toContain("## Selected Image Style");
    expect(stdout).toContain("image-style:ink-storefront");
    expect(stdout).toContain("Single-color hand-drawn ink fineliner");
    expect(stdout).not.toContain("portrait 1024x1536");
    expect(stdout).toContain("## Style Source");
    expect(stdout).toContain("vm0-ai/vm0-skills");
    expect(stdout).toContain("ink-storefront");
    expect(stdout).toContain("## Prompt Compiler Task");
    expect(stdout).toContain("If unavailable, stop without generating");
    expect(stdout).toContain("references, examples, and templates");
    expect(stdout).toContain(
      "Return only the compiled prompt text when preparing the next command",
    );
    expect(stdout).toContain("## Artifact Output Model");
    expect(stdout).toContain("## Requested Parameters");
    expect(stdout.indexOf("## Prompt Compiler Task")).toBeLessThan(
      stdout.indexOf("## Artifact Output Model"),
    );
    expect(stdout.indexOf("## Artifact Output Model")).toBeLessThan(
      stdout.indexOf("## Requested Parameters"),
    );
    expect(stdout).toContain("Requested size: 1024x1024");
    expect(stdout).toContain("Source image URLs: none");
    expect(stdout).toContain("## Image Authoring Rules");
    expect(stdout).not.toContain("## Parameter Precedence");
    expect(stdout).toContain("CLI fallback values last");
    expect(stdout).toContain(
      "`--background` accepts only `auto`, `opaque`, or `transparent`",
    );
    expect(stdout).toContain("--compiled-prompt");
  });

  it("should print an R2-backed style packet when --style-source r2 is selected", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--style",
      "image-style:ink-storefront",
      "--style-source",
      "r2",
      "--prompt",
      "A florist named Luna Floral",
      "--compile",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("Registry resource: `image-style:ink-storefront`");
    expect(stdout).toContain(
      "zero resource pull image-style:ink-storefront --dir ./generated/resources",
    );
    expect(stdout).toContain(
      "./generated/resources/illustration-template/ink-storefront",
    );
    expect(stdout).not.toContain("Repository: `vm0-ai/vm0-skills@main`");
  });

  it("should reject R2 compile mode for a style without an archive", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--style",
        "image-style:chibi-hero",
        "--style-source",
        "r2",
        "--prompt",
        "A chibi hero",
        "--compile",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain(
      "Image style image-style:chibi-hero does not provide an R2 archive",
    );
  });

  it("should fail with mode guidance when no image prompt mode is selected", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--prompt",
        "Anything",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Choose one image prompt mode");
    expect(stderr).toContain("--compiled-prompt");
    expect(stderr).toContain("--raw-prompt");
    expect(stderr).toContain("image-style:notion-illustration");
    expect(stderr).toContain("image-style:vm0-illustration");
  });

  it("should reject compile mode without a prompt", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--style",
        "image-style:notion-illustration",
        "--compile",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain(
      "--compile requires --prompt <text> or piped stdin",
    );
  });

  it("should fail with style listing when --style id is unknown", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--style",
        "image-style:does-not-exist",
        "--prompt",
        "Anything",
        "--compile",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Unknown image style: image-style:does-not-exist");
    expect(stderr).toContain("image-style:notion-illustration");
  });

  it("should reject --style without --compile", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--style",
        "image-style:notion-illustration",
        "--prompt",
        "Anything",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("--style can only be used with --compile");
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

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--raw-prompt",
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
    const normalizedHelpOutput = helpOutput.replace(/\s+/g, " ");

    expect(helpOutput).toContain("gpt-image-1.5");
    expect(helpOutput).toContain("gpt-image-1 (default)");
    expect(helpOutput).toContain("flux-pro-1.1");
    expect(helpOutput).toContain("qwen-image");
    expect(helpOutput).toContain("nano-banana-2");
    expect(normalizedHelpOutput).toContain("support varies");
    expect(helpOutput).toContain("3840x2160");
    expect(helpOutput).toContain("edges divisible by 16");
    expect(helpOutput).toContain("--compression <0-100>");
    expect(helpOutput).toContain("Moderation strictness: auto or low");
    expect(helpOutput).toContain("Uses fal.ai for all image model execution");
    expect(helpOutput).toContain("--seed");
    expect(helpOutput).toContain("--safety-tolerance");
    expect(helpOutput).toContain("--image-url");
    expect(helpOutput).toContain("--image-prompt-strength");
    expect(helpOutput).toContain("Nano Banana 2 accepts up to 14");
    expect(helpOutput).toContain("--style <id>");
    expect(helpOutput).toContain("--style-source <source>");
    expect(helpOutput).toContain("--compile");
    expect(helpOutput).toContain("--compiled-prompt");
    expect(helpOutput).toContain("--raw-prompt");
    expect(helpOutput).not.toContain("--skip-style");
    expect(helpOutput).toContain("--json");
    expect(helpOutput).not.toContain("--styled ");
    expect(helpOutput).toContain("provider");
    expect(helpOutput).toContain("default");
    expect(helpOutput).toContain("not support transparent");
    expect(helpOutput).toContain("backgrounds");
    expect(helpOutput).toContain("Image-to-image");
    expect(helpOutput).toContain("Image Styles:");
    expect(helpOutput).toContain("image-style:notion-illustration");
    expect(helpOutput).toContain("Notion-editorial-style hand-drawn");
    expect(helpOutput).toContain("image-style:vm0-illustration");
    expect(helpOutput).toContain("Generate vm0-style vm0 in-app");
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
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--raw-prompt",
        "hello",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Credits depleted"),
    );
  });
});
