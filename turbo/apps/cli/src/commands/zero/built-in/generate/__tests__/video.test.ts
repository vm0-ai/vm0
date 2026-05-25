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
const FIRST_FRAME_URL = "https://example.com/first.png";
const LAST_FRAME_URL = "https://example.com/last.png";
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

function pngWithDimensions(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function imageResponse(width: number, height: number) {
  return new HttpResponse(pngWithDimensions(width, height), {
    headers: { "content-type": "image/png" },
  });
}

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
    vi.stubEnv("ZERO_TOKEN", "test-token");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("should generate a video and print the /f file URL", async () => {
    server.use(
      http.get(FIRST_FRAME_URL, () => {
        return imageResponse(900, 1600);
      }),
      http.get(LAST_FRAME_URL, () => {
        return imageResponse(900, 1600);
      }),
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
          firstFrameImageUrl: FIRST_FRAME_URL,
          lastFrameImageUrl: LAST_FRAME_URL,
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
      FIRST_FRAME_URL,
      "--last-frame-image-url",
      LAST_FRAME_URL,
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

  it("should reject frame images that do not match --aspect-ratio before generating", async () => {
    const postVideo = vi.fn();
    server.use(
      http.get(FIRST_FRAME_URL, () => {
        return imageResponse(1920, 1080);
      }),
      http.post(VIDEO_URL, () => {
        postVideo();
        return HttpResponse.json(VIDEO_RESULT);
      }),
    );

    await expect(async () => {
      await zeroBuiltInCommand.parseAsync([
        "node",
        "cli",
        "generate",
        "video",
        "--prompt",
        "Animate this frame",
        "--aspect-ratio",
        "9:16",
        "--first-frame-image-url",
        FIRST_FRAME_URL,
      ]);
    }).rejects.toThrow("process.exit called");

    expect(postVideo).not.toHaveBeenCalled();
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "--first-frame-image-url has aspect ratio 16:9 (1920x1080), but --aspect-ratio is 9:16",
      ),
    );
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
