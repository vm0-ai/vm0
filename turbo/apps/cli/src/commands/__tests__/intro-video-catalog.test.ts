import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../mocks/server";
import { introVideoCatalogCommand } from "../__intro-video-catalog";

const API_BASE = "http://localhost:3000/api/intro-video";

describe("internal Intro Video catalog command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-run-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
  });

  it("lists paged public HeyGen avatars for automatic selection", async () => {
    const result = {
      avatars: [
        {
          id: "Daphne_public_1",
          groupId: "public_group",
          name: "Daphne",
          defaultVoiceId: "default_voice",
          previewImageUrl: "https://example.com/daphne.png",
        },
      ],
      hasMore: true,
      nextToken: "next-page",
    } as const;
    server.use(
      http.get(`${API_BASE}/avatars`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-run-token",
        );
        expect(new URL(request.url).searchParams.get("pageSize")).toBe("100");
        return HttpResponse.json(result);
      }),
    );

    await introVideoCatalogCommand.parseAsync([
      "node",
      "cli",
      "avatars",
      "--json",
    ]);

    expect(mockConsoleLog.mock.calls).toEqual([[JSON.stringify(result)]]);
  });

  it("passes voice filters and pagination to the public catalog", async () => {
    const result = {
      voices: [],
      hasMore: false,
      nextToken: null,
    } as const;
    server.use(
      http.get(`${API_BASE}/voices`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("token")).toBe("voice-page");
        expect(url.searchParams.get("language")).toBe("English");
        expect(url.searchParams.get("gender")).toBe("female");
        return HttpResponse.json(result);
      }),
    );

    await introVideoCatalogCommand.parseAsync([
      "node",
      "cli",
      "voices",
      "--token",
      "voice-page",
      "--language",
      "English",
      "--gender",
      "female",
      "--json",
    ]);

    expect(mockConsoleLog.mock.calls).toEqual([[JSON.stringify(result)]]);
  });
});
