/**
 * Tests for zero official generate voice command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend speech route via MSW
 * - Real (internal): All CLI code and fetch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../../../mocks/server";
import { zeroOfficialCommand } from "../../index";

const SPEECH_URL = "http://localhost:3000/api/zero/voice-io/speech";
const VOICE_RESULT = {
  id: "voice-file-id",
  filename: "voice-voice-fi.wav",
  contentType: "audio/wav",
  size: 19,
  url: "http://localhost:3000/f/user-1/voice-file-id/voice-voice-fi.wav",
  durationSeconds: 3,
  creditsCharged: 1,
  model: "gpt-4o-mini-tts",
  voice: "cedar",
};

describe("zero official generate voice command", () => {
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

  it("should generate speech and print the /f file URL", async () => {
    server.use(
      http.post(SPEECH_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.headers.get("content-type")).toBe("application/json");
        expect(await request.json()).toEqual({
          text: "Hello from vm0",
          voice: "cedar",
          instructions: "warm",
        });

        return HttpResponse.json(VOICE_RESULT);
      }),
    );

    await zeroOfficialCommand.parseAsync([
      "node",
      "cli",
      "generate",
      "voice",
      "--text",
      "Hello from vm0",
      "--voice",
      "cedar",
      "--instructions",
      "warm",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(`Voice generated: ${VOICE_RESULT.url}`);
    expect(stdout).toContain(`File: ${VOICE_RESULT.filename}`);
    expect(stdout).toContain("Duration: 3s");
    expect(stdout).toContain("Credits charged: 1");
  });

  it("should print JSON metadata when --json is provided", async () => {
    server.use(
      http.post(SPEECH_URL, () => {
        return HttpResponse.json({ ...VOICE_RESULT, voice: "marin" });
      }),
    );

    await zeroOfficialCommand.parseAsync([
      "node",
      "cli",
      "generate",
      "voice",
      "--text",
      "JSON please",
      "--json",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      id: VOICE_RESULT.id,
      filename: VOICE_RESULT.filename,
      contentType: "audio/wav",
      size: VOICE_RESULT.size,
      url: VOICE_RESULT.url,
      durationSeconds: 3,
      creditsCharged: 1,
      model: "gpt-4o-mini-tts",
      voice: "marin",
    });
  });

  it("should surface API errors", async () => {
    server.use(
      http.post(SPEECH_URL, () => {
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
      await zeroOfficialCommand.parseAsync([
        "node",
        "cli",
        "generate",
        "voice",
        "--text",
        "hello",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Credits depleted"),
    );
  });
});
