import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../mocks/server";
import { introVideoPresenterCommand } from "../__intro-video-presenter";

const GENERATE_URL = "http://localhost:3000/api/intro-video/presenter/generate";

const PRESENTER_RESULT = {
  id: "intro-video-presenter-file-id",
  filename: "intro-video-presenter-abigail.webm",
  contentType: "video/webm",
  size: 1234,
  url: "http://localhost:3000/f/user-1/presenter-id/presenter.webm",
  durationSeconds: 42,
  creditsCharged: 3500,
  avatarId: "Abigail_standing_office_front",
} as const;

describe("internal Intro Video presenter command", () => {
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

  it.each([
    {
      kind: "curated",
      avatarId: "Abigail_standing_office_front",
      avatarGroupId: undefined,
    },
    {
      kind: "public catalog",
      avatarId: "Public_presenter_office",
      avatarGroupId: "public-presenter-group",
    },
  ])(
    "submits the $kind avatar and resolved audio",
    async ({ avatarId, avatarGroupId }) => {
      const result = { ...PRESENTER_RESULT, avatarId };
      server.use(
        http.post(GENERATE_URL, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-run-token",
          );
          expect(await request.json()).toStrictEqual({
            avatarId,
            ...(avatarGroupId ? { avatarGroupId } : {}),
            audioUrl: "https://example.com/voice.mp3",
          });
          return HttpResponse.json(result);
        }),
      );

      await introVideoPresenterCommand.parseAsync([
        "node",
        "cli",
        "--avatar-id",
        avatarId,
        ...(avatarGroupId ? ["--avatar-group-id", avatarGroupId] : []),
        "--audio-url",
        "https://example.com/voice.mp3",
        "--json",
      ]);

      expect(mockConsoleLog.mock.calls).toEqual([[JSON.stringify(result)]]);
    },
  );

  it("rejects malformed avatar IDs before calling the API", async () => {
    const generate = vi.fn();
    server.use(
      http.post(GENERATE_URL, () => {
        generate();
        return HttpResponse.json(PRESENTER_RESULT);
      }),
    );

    await expect(
      introVideoPresenterCommand.parseAsync([
        "node",
        "cli",
        "--avatar-id",
        "not allowed",
        "--audio-url",
        "https://example.com/voice.mp3",
      ]),
    ).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });
});
