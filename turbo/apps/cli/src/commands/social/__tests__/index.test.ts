import { HttpResponse, http } from "msw";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { server } from "../../../mocks/server";
import { socialCommand } from "../index";

type Collection =
  | null
  | {
      readonly state: "complete";
      readonly itemsReturned: number;
      readonly reportedTotal?: number;
    }
  | {
      readonly state: "provider_limited";
      readonly itemsReturned: number;
      readonly reason?: string;
      readonly uncertainty?: { readonly reason: "unreliable_empty_result" };
      readonly reportedTotal?: number;
    }
  | {
      readonly state: "more";
      readonly itemsReturned: number;
      readonly reportedTotal?: number;
      readonly nextInput:
        | { readonly cursor: string }
        | { readonly page: number };
    };

function socialResponse(
  tool: string,
  collection: Collection,
  result: Readonly<Record<string, unknown>>,
  billingQuantity = 1,
) {
  return {
    provider: "socialkit",
    tool,
    billingCategory: "request",
    billingQuantity,
    creditsCharged: billingQuantity * 3,
    collection,
    result,
  };
}

function collectionResult(tool: string): Readonly<Record<string, unknown>> {
  switch (tool) {
    case "linkedin_company_posts": {
      return { posts: [] };
    }
    case "twitter_tweets": {
      return { tweets: [], nextCursor: null };
    }
    case "instagram_channel_posts":
    case "instagram_channel_reels":
    case "instagram_reels_search": {
      return { items: [], hasMore: false };
    }
    case "facebook_comments":
    case "instagram_comments":
    case "tiktok_comments":
    case "youtube_comments": {
      return { comments: [], hasMore: false };
    }
    case "tiktok_channel_videos":
    case "tiktok_hashtag_search":
    case "tiktok_search":
    case "youtube_search":
    case "youtube_videos": {
      return { results: [], hasMore: false };
    }
    default: {
      throw new Error(`Unexpected collection tool ${tool}`);
    }
  }
}

function completedDownload() {
  return {
    downloadId: "6bdc3449-41ef-4624-a525-45bce09c67f0",
    status: "completed",
    platform: "youtube",
    quality: "720p",
    format: "mp4",
    maxDuration: 600,
    billingCategory: "request",
    provider: {
      durationSeconds: 61,
      fileSizeMB: 2,
      creditsCost: 2,
      title: "Example",
    },
    billing: { quantity: 2, creditsCharged: 6 },
    artifact: {
      id: "e5932cce-3ec7-45ef-a96d-2e4c5dcb4cd4",
      url: "https://artifacts.example/video.mp4",
      filename: "example.mp4",
      contentType: "video/mp4",
      sizeBytes: 2048,
    },
    error: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    completedAt: "2026-08-27T00:01:00.000Z",
  };
}

describe("okou social command", () => {
  const originalExitCode = process.exitCode;
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    for (const command of socialCommand.commands) {
      command.setOptionValue("json", undefined);
      command.setOptionValue("thread", undefined);
      command.setOptionValue("kind", undefined);
      command.setOptionValue("limit", 10);
      command.setOptionValue("stream", undefined);
      command.setOptionValue("platform", undefined);
      command.setOptionValue("hashtag", undefined);
      command.setOptionValue("sort", undefined);
      command.setOptionValue("date", undefined);
      command.setOptionValue("type", undefined);
      command.setOptionValue("prompt", undefined);
      command.setOptionValue("maxDuration", undefined);
      command.setOptionValue("quality", undefined);
      command.setOptionValue("format", undefined);
      command.setOptionValue("resume", undefined);
    }
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    process.exitCode = originalExitCode;
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
    mockExit.mockRestore();
  });

  function output(): string {
    return mockConsoleLog.mock.calls.flat().join("\n");
  }

  function errorOutput(): string {
    return mockConsoleError.mock.calls.flat().map(String).join("\n");
  }

  it("discovers concise capabilities locally", async () => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        apiRequests += 1;
        return HttpResponse.json(socialResponse("youtube_stats", null, {}));
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "capabilities",
      "instagram",
      "--json",
    ]);

    const result = JSON.parse(output()) as {
      readonly schemaVersion: string;
      readonly capabilities: readonly {
        readonly platform: string;
        readonly operations: readonly string[];
      }[];
    };
    expect(result).toMatchObject({
      schemaVersion: "social.v1",
      capabilities: [
        {
          platform: "instagram",
          operations: expect.arrayContaining([
            "inspect",
            "posts",
            "search",
            "comments",
          ]),
        },
      ],
    });
    expect(output()).not.toContain("inputSchema");
    expect(output()).not.toContain("instagram_channel_posts");
    expect(apiRequests).toBe(0);
  });

  it.each([
    ["https://linkedin.com/in/example", "linkedin_profile"],
    ["https://linkedin.com/company/example", "linkedin_company"],
    ["https://linkedin.com/posts/example", "linkedin_post"],
    ["https://twitter.com/example", "twitter_profile"],
    ["https://x.com/example/status/1", "twitter_tweet"],
    ["https://facebook.com/example", "facebook_channel_stats"],
    ["https://facebook.com/example/posts/1", "facebook_stats"],
    ["https://instagram.com/example", "instagram_channel_stats"],
    ["https://instagram.com/reel/example", "instagram_stats"],
    ["https://tiktok.com/@example", "tiktok_channel_stats"],
    ["https://tiktok.com/@example/video/1", "tiktok_stats"],
    ["https://youtube.com/@example", "youtube_channel_stats"],
    ["https://youtube.com/watch?v=example", "youtube_stats"],
  ])("routes inspect %s to %s", async (url, expectedTool) => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(socialResponse(expectedTool, null, {}));
        },
      ),
    );

    await socialCommand.parseAsync(["node", "okou", "inspect", url, "--json"]);

    expect(requestBody).toMatchObject({ tool: expectedTool });
    expect(JSON.parse(output()) as unknown).toMatchObject({
      schemaVersion: "social.v1",
      status: "complete",
      operation: "inspect",
    });
  });

  it("canonicalizes supported URLs and routes X threads", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(socialResponse("twitter_thread", null, {}));
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "inspect",
      "http://mobile.twitter.com/example/status/1?utm_source=test#reply",
      "--thread",
      "--json",
    ]);

    expect(requestBody).toStrictEqual({
      tool: "twitter_thread",
      input: { url: "https://x.com/example/status/1" },
    });
    expect(JSON.parse(output()) as unknown).toMatchObject({
      platform: "twitter",
      target: {
        input:
          "http://mobile.twitter.com/example/status/1?utm_source=test#reply",
        canonicalUrl: "https://x.com/example/status/1",
      },
    });
  });

  it.each([
    [
      "https://linkedin.com/company/example",
      undefined,
      "linkedin_company_posts",
    ],
    ["https://x.com/example", undefined, "twitter_tweets"],
    ["https://instagram.com/example", undefined, "instagram_channel_posts"],
    ["https://instagram.com/example", "reels", "instagram_channel_reels"],
    ["https://tiktok.com/@example", undefined, "tiktok_channel_videos"],
    ["https://youtube.com/@example", undefined, "youtube_videos"],
  ])("routes posts %s %s to %s", async (url, kind, expectedTool) => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(
            socialResponse(
              expectedTool,
              { state: "complete", itemsReturned: 0 },
              collectionResult(expectedTool),
            ),
          );
        },
      ),
    );
    const args = ["node", "okou", "posts", url, "--limit", "250", "--json"];
    if (kind) {
      args.push("--kind", kind);
    }

    await socialCommand.parseAsync(args);

    expect(requestBody).toMatchObject({ tool: expectedTool });
    expect(requestBody).toHaveProperty(
      "input.limit",
      expectedTool === "linkedin_company_posts"
        ? 50
        : expectedTool === "tiktok_channel_videos"
          ? 30
          : 100,
    );
  });

  it.each([
    ["instagram", false, "instagram_reels_search"],
    ["tiktok", false, "tiktok_search"],
    ["tiktok", true, "tiktok_hashtag_search"],
    ["youtube", false, "youtube_search"],
  ])("routes %s search to %s", async (platform, hashtag, expectedTool) => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(
            socialResponse(
              expectedTool,
              { state: "complete", itemsReturned: 0 },
              collectionResult(expectedTool),
            ),
          );
        },
      ),
    );
    const args = [
      "node",
      "okou",
      "search",
      hashtag ? "#launch" : "launch",
      "--platform",
      platform,
      "--json",
    ];
    if (hashtag) {
      args.push("--hashtag");
    }

    await socialCommand.parseAsync(args);

    expect(requestBody).toMatchObject({ tool: expectedTool });
    if (hashtag) {
      expect(requestBody).toHaveProperty("input.hashtag", "launch");
    }
  });

  it.each([
    ["https://facebook.com/example/posts/1", "facebook_comments"],
    ["https://instagram.com/p/example", "instagram_comments"],
    ["https://tiktok.com/@example/video/1", "tiktok_comments"],
    ["https://youtu.be/example", "youtube_comments"],
  ])("routes comments %s to %s", async (url, expectedTool) => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(
            socialResponse(
              expectedTool,
              { state: "complete", itemsReturned: 0 },
              collectionResult(expectedTool),
            ),
          );
        },
      ),
    );

    await socialCommand.parseAsync(["node", "okou", "comments", url, "--json"]);

    expect(requestBody).toMatchObject({ tool: expectedTool });
  });

  it.each([
    ["https://linkedin.com/posts/example", "linkedin_transcript"],
    ["https://x.com/example/status/1", "twitter_transcript"],
    ["https://facebook.com/example/videos/1", "facebook_transcript"],
    ["https://instagram.com/reel/example", "instagram_transcript"],
    ["https://tiktok.com/@example/video/1", "tiktok_transcript"],
    ["https://youtu.be/example", "youtube_transcript"],
  ])("routes transcript %s to %s", async (url, expectedTool) => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(
            socialResponse(expectedTool, null, { transcript: "Example" }),
          );
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "transcript",
      url,
      "--json",
    ]);

    expect(requestBody).toMatchObject({ tool: expectedTool });
  });

  it.each([
    ["https://facebook.com/example/videos/1", "facebook_summarize"],
    ["https://instagram.com/reel/example", "instagram_summarize"],
    ["https://tiktok.com/@example/video/1", "tiktok_summarize"],
    ["https://youtu.be/example", "youtube_summarize"],
  ])("routes summarize %s to %s", async (url, expectedTool) => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(
            socialResponse(expectedTool, null, { summary: "Example" }),
          );
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "summarize",
      url,
      "--prompt",
      "Focus on outcomes",
      "--json",
    ]);

    expect(requestBody).toMatchObject({
      tool: expectedTool,
      input: { custom_prompt: "Focus on outcomes" },
    });
  });

  it("aggregates pages, trims provider overshoot, and totals billing", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requests.push(await request.json());
          const firstPage = requests.length === 1;
          const comments = Array.from({ length: 7 }, (_, index) => {
            return { id: `${firstPage ? "a" : "b"}-${index}` };
          });
          return HttpResponse.json(
            socialResponse(
              "instagram_comments",
              {
                state: "more",
                itemsReturned: 7,
                reportedTotal: 82,
                nextInput: { cursor: firstPage ? "next" : "after-next" },
              },
              { comments, hasMore: true, commentCount: 82 },
              2,
            ),
          );
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "comments",
      "https://instagram.com/p/example",
      "--limit",
      "10",
      "--json",
    ]);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveProperty("input.limit", 10);
    expect(requests[1]).toHaveProperty("input.limit", 3);
    const result = JSON.parse(output()) as {
      readonly status: string;
      readonly data: { readonly items: readonly unknown[] };
      readonly collection: Readonly<Record<string, unknown>>;
      readonly billing: Readonly<Record<string, unknown>>;
    };
    expect(result.status).toBe("complete");
    expect(result.data.items).toHaveLength(10);
    expect(result.collection).toMatchObject({
      state: "caller_limited",
      pages: 2,
      itemsReturned: 10,
      itemsObserved: 14,
      requestedItems: 10,
      reportedTotal: 82,
    });
    expect(result.billing).toMatchObject({
      quantity: 4,
      creditsCharged: 12,
    });
  });

  it("marks a complete provider page caller-limited when trimming overshoot", async () => {
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        return HttpResponse.json(
          socialResponse(
            "youtube_search",
            { state: "complete", itemsReturned: 3 },
            {
              results: [{ id: "one" }, { id: "two" }, { id: "three" }],
              hasMore: false,
            },
          ),
        );
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "search",
      "launch",
      "--platform",
      "youtube",
      "--limit",
      "2",
      "--json",
    ]);

    expect(JSON.parse(output()) as unknown).toMatchObject({
      status: "complete",
      data: { items: [{ id: "one" }, { id: "two" }] },
      collection: {
        state: "caller_limited",
        itemsReturned: 2,
        itemsObserved: 3,
      },
      warnings: [{ code: "RESULT_LIMIT_REACHED" }],
    });
  });

  it("marks an unsatisfied provider-limited collection partial", async () => {
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        return HttpResponse.json(
          socialResponse(
            "youtube_comments",
            {
              state: "provider_limited",
              itemsReturned: 2,
              reason: "no_pagination",
            },
            { comments: [{ id: "1" }, { id: "2" }] },
          ),
        );
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "comments",
      "https://youtu.be/example",
      "--limit",
      "10",
      "--json",
    ]);

    expect(JSON.parse(output()) as unknown).toMatchObject({
      status: "partial",
      collection: {
        state: "provider_limited",
        itemsReturned: 2,
        requestedItems: 10,
      },
      warnings: [{ code: "PROVIDER_LIMITED" }],
    });
    expect(process.exitCode).toBe(2);
  });

  it("detects repeated pagination and emits a structured error", async () => {
    let requests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        requests += 1;
        return HttpResponse.json(
          socialResponse(
            "tiktok_search",
            {
              state: "more",
              itemsReturned: 1,
              nextInput: { cursor: "same" },
            },
            {
              results: [{ id: `video-${requests}` }],
              hasMore: true,
              cursor: "same",
            },
          ),
        );
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "okou",
        "search",
        "launch",
        "--platform",
        "tiktok",
        "--limit",
        "10",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requests).toBe(2);
    expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
      schemaVersion: "social.v1",
      status: "error",
      error: {
        kind: "internal",
        code: "INTERNAL",
        message: "Okou Social returned a repeated pagination state",
      },
      progress: { pages: 2, itemsReturned: 2 },
    });
  });

  it("streams only when explicitly requested", async () => {
    let requests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        requests += 1;
        const firstPage = requests === 1;
        return HttpResponse.json(
          socialResponse(
            "instagram_comments",
            firstPage
              ? {
                  state: "more",
                  itemsReturned: 1,
                  nextInput: { cursor: "next" },
                }
              : { state: "complete", itemsReturned: 1 },
            {
              comments: [{ id: String(requests) }],
              hasMore: firstPage,
              ...(firstPage ? { cursor: "next" } : {}),
            },
          ),
        );
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "comments",
      "https://instagram.com/p/example",
      "--limit",
      "10",
      "--stream",
    ]);

    const records = mockConsoleLog.mock.calls.map(([value]) => {
      return JSON.parse(String(value)) as Readonly<Record<string, unknown>>;
    });
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ kind: "page", page: 1 });
    expect(records[1]).toMatchObject({ kind: "page", page: 2 });
    expect(records[2]).toMatchObject({
      schemaVersion: "social.v1",
      kind: "result",
      status: "complete",
      collection: { pages: 2 },
    });
  });

  it("emits structured API failures and exits non-zero", async () => {
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        return HttpResponse.json(
          {
            error: {
              code: "SOCIAL_UPSTREAM_ERROR",
              message: "The social data service is temporarily unavailable",
            },
          },
          { status: 502 },
        );
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "okou",
        "inspect",
        "https://instagram.com/p/example",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(JSON.parse(errorOutput()) as unknown).toStrictEqual({
      schemaVersion: "social.v1",
      status: "error",
      error: {
        kind: "provider_temporary",
        code: "SOCIAL_UPSTREAM_ERROR",
        message: "The social data service is temporarily unavailable",
        httpStatus: 502,
        retryable: true,
      },
    });
  });

  it("rejects unsupported hosts before managed work", async () => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        apiRequests += 1;
        return HttpResponse.json(socialResponse("youtube_stats", null, {}));
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "okou",
        "inspect",
        "https://example.com/video",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(apiRequests).toBe(0);
    expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
      status: "error",
      error: { kind: "invalid_input", code: "INVALID_INPUT" },
    });
  });

  it.each([
    ["transcript", "https://instagram.com/example"],
    ["transcript", "https://youtube.com/"],
    ["transcript", "https://youtu.be/"],
    ["transcript", "https://vm.tiktok.com/"],
    ["transcript", "https://instagram.com/explore/"],
    ["transcript", "https://linkedin.com/posts"],
    ["transcript", "https://facebook.com/watch"],
  ])(
    "rejects mismatched %s target %s before managed work",
    async (operation, url) => {
      let apiRequests = 0;
      server.use(
        http.post("http://localhost:3000/api/social/request", () => {
          apiRequests += 1;
          return HttpResponse.json(
            socialResponse("youtube_transcript", null, {}),
          );
        }),
      );

      await expect(
        socialCommand.parseAsync(["node", "okou", operation, url, "--json"]),
      ).rejects.toThrow("process.exit called");

      expect(apiRequests).toBe(0);
      expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
        status: "error",
        error: {
          kind: "invalid_input",
          message: "transcript requires a public post or video URL",
        },
      });
    },
  );

  it.each([
    ["inspect", "https://instagram.com/p/example", "--thread"],
    ["posts", "https://x.com/example", "--kind", "reels"],
    [
      "search",
      "launch",
      "--platform",
      "tiktok",
      "--hashtag",
      "--sort",
      "likes",
    ],
  ])("rejects mismatched %s options before managed work", async (...args) => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        apiRequests += 1;
        return HttpResponse.json(socialResponse("youtube_stats", null, {}));
      }),
    );

    await expect(
      socialCommand.parseAsync(["node", "okou", ...args, "--json"]),
    ).rejects.toThrow("process.exit called");

    expect(apiRequests).toBe(0);
    expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
      status: "error",
      error: { kind: "invalid_input" },
    });
  });

  it("auto-detects downloads and prints the stable envelope", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/downloads",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(completedDownload(), { status: 202 });
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "download",
      "https://youtu.be/example?si=tracking",
      "--max-duration",
      "600",
      "--json",
    ]);

    expect(requestBody).toStrictEqual({
      platform: "youtube",
      url: "https://youtu.be/example",
      maxDuration: 600,
      quality: "720p",
      format: "mp4",
    });
    expect(JSON.parse(output()) as unknown).toMatchObject({
      schemaVersion: "social.v1",
      status: "complete",
      operation: "download",
      platform: "youtube",
      billing: { quantity: 2, creditsCharged: 6 },
      data: { status: "completed", artifact: { filename: "example.mp4" } },
    });
  });

  it("resumes an existing download without a new request", async () => {
    let creates = 0;
    server.use(
      http.post("http://localhost:3000/api/social/downloads", () => {
        creates += 1;
        return HttpResponse.json(completedDownload(), { status: 202 });
      }),
      http.get("http://localhost:3000/api/social/downloads/:downloadId", () => {
        return HttpResponse.json(completedDownload());
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "download",
      "--resume",
      "6bdc3449-41ef-4624-a525-45bce09c67f0",
      "--json",
    ]);

    expect(creates).toBe(0);
    expect(JSON.parse(output()) as unknown).toMatchObject({
      target: {
        kind: "download",
        downloadId: "6bdc3449-41ef-4624-a525-45bce09c67f0",
      },
    });
  });

  it("documents the intent-oriented surface", () => {
    const help = socialCommand.helpInformation();
    let renderedHelp = "";
    socialCommand.configureOutput({
      writeOut: (value) => {
        renderedHelp += value;
      },
    });
    socialCommand.outputHelp();
    const postsHelp = socialCommand.commands
      .find((command) => {
        return command.name() === "posts";
      })
      ?.helpInformation();
    expect(help).toContain("capabilities");
    expect(help).toContain("inspect");
    expect(help).toContain("comments");
    expect(postsHelp).toContain("Maximum total items to return");
    expect(renderedHelp).toContain(
      "Provider credentials remain on the Okou API server",
    );
  });
});
