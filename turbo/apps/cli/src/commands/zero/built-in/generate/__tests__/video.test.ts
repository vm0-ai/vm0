/**
 * Tests for zero built-in generate video command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend video route via MSW
 * - Real (internal): All CLI code and fetch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../../../mocks/server";
import { zeroBuiltInCommand } from "../../index";
import { videoCommand } from "../video";

const VIDEO_URL = "http://localhost:3000/api/zero/video-io/generate";
const VIDEO_RESULT = {
  id: "video-file-id",
  filename: "video-video-fi.mp4",
  contentType: "video/mp4",
  size: 19,
  url: "http://localhost:3000/f/user-1/video-file-id/video-video-fi.mp4",
  durationSeconds: 6,
  creditsCharged: 720,
  model: "dreamina-seedance-2-0-fast-260128",
  aspectRatio: "9:16",
  duration: "6s",
  resolution: "1080p",
  generateAudio: false,
  sourceUrl: "https://ark-content.byteplus.example/files/video-output.mp4",
  requestId: "video-request",
};

describe("zero built-in generate video command", () => {
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

  it("should generate a video and print the /f file URL", async () => {
    server.use(
      http.post(VIDEO_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.headers.get("content-type")).toBe("application/json");
        expect(await request.json()).toEqual({
          prompt: "A neon market tracking shot",
          model: "dreamina-seedance-2.0",
          aspectRatio: "9:16",
          duration: "6s",
          resolution: "1080p",
          generateAudio: false,
          seed: 123,
          autoFix: false,
          safetyTolerance: "5",
          imageUrls: ["https://example.com/reference.png"],
          videoUrls: ["https://example.com/reference.mp4"],
          audioUrls: ["https://example.com/reference.mp3"],
          firstFrameImageUrl: "https://example.com/first.png",
          lastFrameImageUrl: "https://example.com/last.png",
        });

        return HttpResponse.json(VIDEO_RESULT);
      }),
    );

    await zeroBuiltInCommand.parseAsync([
      "node",
      "cli",
      "generate",
      "video",
      "--prompt",
      "A neon market tracking shot",
      "--model",
      "dreamina-seedance-2.0",
      "--aspect-ratio",
      "9:16",
      "--duration",
      "6s",
      "--resolution",
      "1080p",
      "--no-audio",
      "--seed",
      "123",
      "--no-auto-fix",
      "--safety-tolerance",
      "5",
      "--image-url",
      "https://example.com/reference.png",
      "--video-url",
      "https://example.com/reference.mp4",
      "--audio-url",
      "https://example.com/reference.mp3",
      "--first-frame-image-url",
      "https://example.com/first.png",
      "--last-frame-image-url",
      "https://example.com/last.png",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(`Video generated: ${VIDEO_RESULT.url}`);
    expect(stdout).toContain(`File: ${VIDEO_RESULT.filename}`);
    expect(stdout).toContain("Duration: 6s");
    expect(stdout).toContain("Resolution: 1080p");
    expect(stdout).toContain("Aspect ratio: 9:16");
    expect(stdout).toContain("Audio: off");
    expect(stdout).toContain("Credits charged: 720");
  });

  it("should print JSON metadata when --json is provided", async () => {
    server.use(
      http.post(VIDEO_URL, () => {
        return HttpResponse.json(VIDEO_RESULT);
      }),
    );

    await zeroBuiltInCommand.parseAsync([
      "node",
      "cli",
      "generate",
      "video",
      "--prompt",
      "JSON please",
      "--json",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      id: VIDEO_RESULT.id,
      filename: VIDEO_RESULT.filename,
      contentType: "video/mp4",
      size: VIDEO_RESULT.size,
      url: VIDEO_RESULT.url,
      creditsCharged: 720,
      model: "dreamina-seedance-2-0-fast-260128",
      duration: "6s",
      resolution: "1080p",
      aspectRatio: "9:16",
      generateAudio: false,
    });
  });

  it("should describe video generation models in help", () => {
    let helpOutput = "";
    videoCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    videoCommand.outputHelp();

    expect(helpOutput).toContain("Models:");
    expect(helpOutput).toContain("dreamina-seedance-2.0-fast");
    expect(helpOutput).toContain("dreamina-seedance-2.0");
    expect(helpOutput).toContain("seedance-1.5-pro");
    expect(helpOutput).toContain("veo3.1-fast");
    expect(helpOutput).toContain("kling-v3-4k");
    expect(helpOutput).not.toContain("seedance-1.0-pro");
    expect(helpOutput).toContain("4s-15s");
    expect(helpOutput).toContain("21:9");
    expect(helpOutput).toContain("--image-url");
    expect(helpOutput).toContain("--first-frame-image-url");
    expect(helpOutput).toContain("--last-frame-image-url");
  });

  it("should surface API errors", async () => {
    server.use(
      http.post(VIDEO_URL, () => {
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
        "video",
        "--prompt",
        "hello",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Credits depleted"),
    );
  });
});
