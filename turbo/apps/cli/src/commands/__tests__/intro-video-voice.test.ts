import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../mocks/server";
import { introVideoVoiceCommand } from "../__intro-video-voice";

const GENERATE_URL = "http://localhost:3000/api/intro-video/voice/generate";

const VOICE_RESULT = {
  id: "intro-video-voice-file-id",
  filename: "intro-video-voice-annie.mp3",
  contentType: "audio/mpeg",
  size: 1234,
  url: "http://localhost:3000/f/user-1/voice-id/narration.mp3",
  durationSeconds: 42,
  creditsCharged: 28,
  voiceId: "330290724a1b470fb63153f34d4c0183",
} as const;

describe("internal Intro Video voice command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-run-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("submits the exact selected HeyGen voice and narration", async () => {
    server.use(
      http.post(GENERATE_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-run-token",
        );
        await expect(request.json()).resolves.toStrictEqual({
          voiceId: VOICE_RESULT.voiceId,
          text: "Welcome to the launch.",
        });
        return HttpResponse.json(VOICE_RESULT);
      }),
    );

    await introVideoVoiceCommand.parseAsync([
      "node",
      "cli",
      "--voice-id",
      VOICE_RESULT.voiceId,
      "--text",
      "Welcome to the launch.",
      "--json",
    ]);

    expect(mockConsoleLog.mock.calls).toEqual([[JSON.stringify(VOICE_RESULT)]]);
  });

  it("rejects malformed voice IDs before calling the API", async () => {
    const generate = vi.fn();
    server.use(
      http.post(GENERATE_URL, () => {
        generate();
        return HttpResponse.json(VOICE_RESULT);
      }),
    );

    await expect(
      introVideoVoiceCommand.parseAsync([
        "node",
        "cli",
        "--voice-id",
        "not allowed",
        "--text",
        "Welcome to the launch.",
      ]),
    ).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });
});
