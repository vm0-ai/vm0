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
  model: "fal-ai/veo3.1/fast",
  aspectRatio: "9:16",
  duration: "6s",
  resolution: "1080p",
  generateAudio: false,
  sourceUrl: "https://v3b.fal.media/files/video-output.mp4",
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
          model: "kling-o3-standard",
          aspectRatio: "9:16",
          duration: "6s",
          resolution: "1080p",
          generateAudio: false,
          seed: 123,
          autoFix: false,
          safetyTolerance: "5",
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
      "kling-o3-standard",
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
      model: "fal-ai/veo3.1/fast",
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
    expect(helpOutput).toContain("veo3.1-fast");
    expect(helpOutput).toContain("veo3.1");
    expect(helpOutput).toContain("kling-o3-standard");
    expect(helpOutput).toContain("kling-v3-4k");
    expect(helpOutput).toContain("seedance2.0");
    expect(helpOutput).toContain("seedance2.0-fast");
    expect(helpOutput).toContain("4s/6s/8s");
    expect(helpOutput).toContain("3s-15s");
    expect(helpOutput).toContain("21:9");
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
