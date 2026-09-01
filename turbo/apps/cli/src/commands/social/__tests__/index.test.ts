import { mkdtempSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { HttpResponse, http } from "msw";
import { z } from "zod";
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

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "social-home-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => {
      return TEST_HOME;
    },
  };
});

const jsonSchema = z.object({}).loose();
const catalogSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      inputSchema: jsonSchema,
      outputSchema: jsonSchema,
      availability: z.literal("transcript").optional(),
      collection: z
        .object({
          resultField: z.string(),
          retrieval: z.object({ kind: z.string() }).loose(),
          reportedTotalField: z.string().optional(),
          providerLimit: z.object({ kind: z.string() }).loose().optional(),
        })
        .nullable(),
      billing: z.object({ kind: z.string() }).loose(),
    }),
  ),
});

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

function publicSocialResponseFixture(
  response: ReturnType<typeof socialResponse>,
) {
  return {
    tool: response.tool,
    billingCategory: response.billingCategory,
    billingQuantity: response.billingQuantity,
    creditsCharged: response.creditsCharged,
    collection: response.collection,
    result: response.result,
  };
}

function failedDownloadResponse(status: "provider_failed" | "artifact_failed") {
  const billed = status === "artifact_failed";
  return {
    downloadId: "6bdc3449-41ef-4624-a525-45bce09c67f0",
    status,
    platform: "youtube",
    quality: "720p",
    format: "mp4",
    maxDuration: 600,
    billingCategory: "request",
    provider: billed
      ? { durationSeconds: 61, fileSizeMB: 2, creditsCost: 2 }
      : null,
    billing: billed ? { quantity: 2, creditsCharged: 6 } : null,
    artifact: null,
    error: {
      code: billed
        ? "ARTIFACT_MATERIALIZATION_FAILED"
        : "SOCIALKIT_DOWNLOAD_FAILED",
      message: billed
        ? "The artifact could not be materialized"
        : "SocialKit could not prepare the download",
      retryable: billed,
      billed,
    },
    createdAt: "2026-08-27T00:00:00.000Z",
    completedAt: billed ? null : "2026-08-27T00:01:00.000Z",
  };
}

describe("okou social command", () => {
  const originalExitCode = process.exitCode;
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockStderrWrite = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((() => {
      return true;
    }) as never);
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(async () => {
    await fs.rm(path.join(TEST_HOME, ".vm0"), { recursive: true, force: true });
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-zero-token");
    for (const command of socialCommand.commands) {
      command.setOptionValue("input", undefined);
      command.setOptionValue("all", undefined);
      command.setOptionValue("maxPages", undefined);
      command.setOptionValue("maxItems", undefined);
      command.setOptionValue("json", undefined);
      command.setOptionValue("maxDuration", undefined);
      command.setOptionValue("quality", undefined);
      command.setOptionValue("format", undefined);
      command.setOptionValue("resume", undefined);
    }
  });

  afterEach(async () => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockStderrWrite.mockClear();
    mockExit.mockClear();
    process.exitCode = originalExitCode;
    vi.unstubAllEnvs();
    await fs.rm(path.join(TEST_HOME, ".vm0"), { recursive: true, force: true });
  });

  afterAll(async () => {
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
    mockStderrWrite.mockRestore();
    mockExit.mockRestore();
    await fs.rm(TEST_HOME, { recursive: true, force: true });
  });

  function output(): string {
    return mockConsoleLog.mock.calls.flat().join("\n");
  }

  function errorOutput(): string {
    return [
      ...mockConsoleError.mock.calls.flat(),
      ...mockStderrWrite.mock.calls.flat(),
    ]
      .map(String)
      .join("\n");
  }

  it("prints all typed tools as local compact JSON", async () => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        apiRequests += 1;
        return HttpResponse.json(
          socialResponse("youtube_transcript", null, {}),
        );
      }),
    );

    await socialCommand.parseAsync(["node", "cli", "tools", "--json"]);

    const catalog = catalogSchema.parse(JSON.parse(output()) as unknown);
    expect(catalog.tools).toHaveLength(38);
    expect(
      new Set(
        catalog.tools.map((tool) => {
          return tool.name;
        }),
      ).size,
    ).toBe(38);
    expect(apiRequests).toBe(0);

    const search = catalog.tools.find((tool) => {
      return tool.name === "youtube_search";
    });
    expect(search?.inputSchema).toMatchObject({
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cache: {
          type: "boolean",
          description: "Whether the provider may cache the result",
        },
      },
    });
    expect(search?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        query: { type: "string" },
        results: { type: "array" },
      },
    });
    expect(search?.collection).toStrictEqual({
      resultField: "results",
      retrieval: { kind: "provider_limited" },
      providerLimit: { kind: "no_pagination" },
    });
    const transcript = catalog.tools.find((tool) => {
      return tool.name === "youtube_transcript";
    });
    expect(transcript?.availability).toBe("transcript");
    const comments = catalog.tools.find((tool) => {
      return tool.name === "tiktok_comments";
    });
    expect(comments?.collection).toMatchObject({
      reportedTotalField: "commentCount",
    });
    const reelsSearch = catalog.tools.find((tool) => {
      return tool.name === "instagram_reels_search";
    });
    expect(reelsSearch?.collection).toMatchObject({
      providerLimit: { kind: "max_page", maxPage: 2 },
    });

    const summary = catalog.tools.find((tool) => {
      return tool.name === "youtube_summarize";
    });
    expect(summary?.inputSchema).toMatchObject({
      properties: { custom_response: { anyOf: expect.any(Array) } },
    });
    expect(summary?.outputSchema).toMatchObject({
      properties: {
        summary: { type: "string" },
        keyPoints: { type: "array" },
      },
    });
  });

  it("prints readable input and output schemas", async () => {
    await socialCommand.parseAsync(["node", "cli", "tools"]);

    expect(output()).toContain("youtube_transcript");
    expect(output()).toContain("Input schema:");
    expect(output()).toContain("Output schema:");
    expect(output()).toContain("instagram_comments");
    expect(output()).toContain("Collection: comments (cursor)");
    expect(output()).toContain("Reported total: commentCount");
    expect(output()).toContain("Provider limit: no pagination");
    expect(output()).toContain(
      "Availability: transcript (provider evidence required; unknown remains explicit)",
    );
  });

  it("calls a tool with typed JSON input", async () => {
    let requestBody: unknown;
    const response = socialResponse(
      "youtube_search",
      { state: "provider_limited", itemsReturned: 1 },
      {
        query: "typed tools",
        results: [{ title: "Typed result", views: 10 }],
        providerName: "SocialKit",
        nested: {
          providerCode: "socialkit",
          items: [{ upstreamProvider: "socialkit" }],
        },
        source: { provider: "youtube" },
      },
    );
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = (await request.json()) as unknown;
          return HttpResponse.json(response);
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "cli",
      "call",
      "youtube_search",
      "--input",
      '{"query":"typed tools","limit":10,"cache":false}',
      "--json",
    ]);

    expect(requestBody).toStrictEqual({
      tool: "youtube_search",
      input: { query: "typed tools", limit: 10, cache: false },
    });
    expect(JSON.parse(output()) as unknown).toStrictEqual({
      ...publicSocialResponseFixture(response),
      result: {
        query: "typed tools",
        results: [{ title: "Typed result", views: 10 }],
        nested: { items: [{}] },
        source: { provider: "youtube" },
      },
    });
    expect(output()).not.toMatch(/socialkit/iu);
  });

  it("keeps custom response objects typed in the request", async () => {
    let requestBody: unknown;
    const response = socialResponse("youtube_summarize", null, {
      summary: "Short summary",
      title: "Custom title",
    });
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = (await request.json()) as unknown;
          return HttpResponse.json(response);
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "cli",
      "call",
      "youtube_summarize",
      "--input",
      '{"url":"https://youtu.be/id","custom_response":{"title":"Video title"}}',
    ]);

    expect(requestBody).toStrictEqual({
      tool: "youtube_summarize",
      input: {
        url: "https://youtu.be/id",
        custom_response: { title: "Video title" },
      },
    });
    expect(output()).toBe(
      JSON.stringify(publicSocialResponseFixture(response), null, 2),
    );
  });

  it("retrieves typed cursor pages with provider-max page size", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requests.push((await request.json()) as unknown);
          const firstPage = requests.length === 1;
          return HttpResponse.json(
            socialResponse(
              "instagram_comments",
              firstPage
                ? {
                    state: "more",
                    itemsReturned: 2,
                    nextInput: { cursor: "next-page" },
                  }
                : { state: "complete", itemsReturned: 1 },
              {
                comments: firstPage
                  ? [{ id: "1" }, { id: "2" }]
                  : [{ id: "3" }],
                hasMore: firstPage,
              },
            ),
          );
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "cli",
      "call",
      "instagram_comments",
      "--input",
      '{"url":"https://instagram.com/p/example"}',
      "--all",
      "--json",
    ]);

    expect(requests).toStrictEqual([
      {
        tool: "instagram_comments",
        input: { url: "https://instagram.com/p/example", limit: 100 },
      },
      {
        tool: "instagram_comments",
        input: {
          url: "https://instagram.com/p/example",
          limit: 100,
          cursor: "next-page",
        },
      },
    ]);
    const records = mockConsoleLog.mock.calls.map(([value]) => {
      return JSON.parse(String(value)) as unknown;
    });
    expect(records[0]).toStrictEqual({
      kind: "page",
      pageNumber: 1,
      response: {
        tool: "instagram_comments",
        billingCategory: "request",
        billingQuantity: 1,
        creditsCharged: 3,
        collection: {
          state: "more",
          itemsReturned: 2,
          nextInput: { cursor: "next-page" },
        },
        result: {
          comments: [{ id: "1" }, { id: "2" }],
          hasMore: true,
        },
      },
    });
    expect(records[1]).toStrictEqual({
      kind: "page",
      pageNumber: 2,
      response: {
        tool: "instagram_comments",
        billingCategory: "request",
        billingQuantity: 1,
        creditsCharged: 3,
        collection: { state: "complete", itemsReturned: 1 },
        result: { comments: [{ id: "3" }], hasMore: false },
      },
    });
    expect(records[2]).toStrictEqual({
      kind: "summary",
      completion: "complete",
      pages: 2,
      itemsReturned: 3,
      billingQuantity: 2,
      creditsCharged: 6,
    });
  });

  it("follows typed numeric pages to the provider ceiling", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requests.push((await request.json()) as unknown);
          const firstPage = requests.length === 1;
          return HttpResponse.json(
            socialResponse(
              "instagram_reels_search",
              firstPage
                ? {
                    state: "more",
                    itemsReturned: 1,
                    nextInput: { page: 2 },
                  }
                : { state: "provider_limited", itemsReturned: 1 },
              { items: [{ id: String(requests.length) }], hasMore: true },
            ),
          );
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "cli",
      "call",
      "instagram_reels_search",
      "--input",
      '{"query":"cats"}',
      "--all",
      "--json",
    ]);

    expect(requests).toStrictEqual([
      { tool: "instagram_reels_search", input: { query: "cats" } },
      {
        tool: "instagram_reels_search",
        input: { query: "cats", page: 2 },
      },
    ]);
    expect(JSON.parse(String(mockConsoleLog.mock.calls.at(-1)?.[0]))).toEqual({
      kind: "summary",
      completion: "provider_limited",
      pages: 2,
      itemsReturned: 2,
      billingQuantity: 2,
      creditsCharged: 6,
    });
  });

  it("reports provider completeness evidence in full retrieval output", async () => {
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        return HttpResponse.json(
          socialResponse(
            "tiktok_comments",
            {
              state: "provider_limited",
              itemsReturned: 2,
              reason: "reported_total_exceeds_page",
              reportedTotal: 100,
            },
            {
              comments: [{ id: "1" }, { id: "2" }],
              commentCount: 100,
              hasMore: false,
              cursor: null,
            },
          ),
        );
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "cli",
      "call",
      "tiktok_comments",
      "--input",
      '{"url":"https://tiktok.com/@example/video/123"}',
      "--all",
      "--json",
    ]);

    const records = mockConsoleLog.mock.calls.map(([value]) => {
      return JSON.parse(String(value)) as Record<string, unknown>;
    });
    expect(records[0]).toMatchObject({
      kind: "page",
      response: {
        collection: {
          state: "provider_limited",
          reason: "reported_total_exceeds_page",
          reportedTotal: 100,
        },
      },
    });
    expect(records[1]).toStrictEqual({
      kind: "summary",
      completion: "provider_limited",
      pages: 1,
      itemsReturned: 2,
      billingQuantity: 1,
      creditsCharged: 3,
      providerLimitedReason: "reported_total_exceeds_page",
      reportedTotal: 100,
    });
  });

  it("honors typed caller item limits", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          const body: unknown = await request.json();
          requests.push(body);
          return HttpResponse.json(
            socialResponse(
              "tiktok_search",
              {
                state: "more",
                itemsReturned: 3,
                nextInput: { cursor: "next-page" },
              },
              { results: [], hasMore: true },
            ),
          );
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "cli",
      "call",
      "tiktok_search",
      "--input",
      '{"query":"launch"}',
      "--all",
      "--max-items",
      "3",
      "--json",
    ]);

    expect(requests).toStrictEqual([
      {
        tool: "tiktok_search",
        input: { query: "launch", limit: 3 },
      },
    ]);
    expect(JSON.parse(String(mockConsoleLog.mock.calls.at(-1)?.[0]))).toEqual({
      kind: "summary",
      completion: "caller_limited",
      pages: 1,
      itemsReturned: 3,
      billingQuantity: 1,
      creditsCharged: 3,
    });
  });

  it("preserves emitted pages and reports a failed summary", async () => {
    let requestCount = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        requestCount += 1;
        if (requestCount === 2) {
          return HttpResponse.json(
            {
              error: {
                message: "The requested social content is unavailable",
                code: "SOCIALKIT_CONTENT_UNAVAILABLE",
              },
            },
            { status: 404 },
          );
        }
        return HttpResponse.json(
          socialResponse(
            "tiktok_channel_videos",
            {
              state: "more",
              itemsReturned: 1,
              nextInput: { cursor: "unstable-page" },
            },
            { results: [{ videoId: "1" }], hasMore: true },
          ),
        );
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "cli",
        "call",
        "tiktok_channel_videos",
        "--input",
        '{"url":"https://tiktok.com/@example"}',
        "--all",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    const records = mockConsoleLog.mock.calls.map(([value]) => {
      return JSON.parse(String(value)) as unknown;
    });
    expect(records[0]).toMatchObject({ kind: "page", pageNumber: 1 });
    expect(records[1]).toStrictEqual({
      kind: "summary",
      completion: "failed",
      pages: 1,
      itemsReturned: 1,
      billingQuantity: 1,
      creditsCharged: 3,
    });
    expect(errorOutput()).toContain(
      "404: The requested social content is unavailable",
    );
  });

  it("rejects repeated pagination without a third API request", async () => {
    let requestCount = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        requestCount += 1;
        return HttpResponse.json(
          socialResponse(
            "tiktok_search",
            {
              state: "more",
              itemsReturned: 1,
              nextInput: { cursor: "repeated-cursor" },
            },
            { results: [{ id: String(requestCount) }], hasMore: true },
          ),
        );
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "cli",
        "call",
        "tiktok_search",
        "--input",
        '{"query":"launch"}',
        "--all",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requestCount).toBe(2);
    expect(JSON.parse(String(mockConsoleLog.mock.calls.at(-1)?.[0]))).toEqual({
      kind: "summary",
      completion: "failed",
      pages: 2,
      itemsReturned: 2,
      billingQuantity: 2,
      creditsCharged: 6,
    });
    expect(errorOutput()).toContain("repeated pagination state");
  });

  it("rejects a collection response without page metadata", async () => {
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        return HttpResponse.json(
          socialResponse("tiktok_search", null, {
            results: [],
            hasMore: false,
          }),
        );
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "cli",
        "call",
        "tiktok_search",
        "--input",
        '{"query":"launch"}',
        "--all",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain(
      "Okou Social collection response has no page metadata",
    );
  });

  it.each([
    {
      caseName: "an unknown tool",
      args: ["call", "youtube_unknown", "--input", "{}"],
      message: "Unknown Okou Social tool",
    },
    {
      caseName: "malformed JSON",
      args: ["call", "youtube_transcript", "--input", "{"],
      message: "valid JSON",
    },
    {
      caseName: "a string number",
      args: [
        "call",
        "youtube_search",
        "--input",
        '{"query":"launch","limit":"10"}',
      ],
      message: "expected number",
    },
    {
      caseName: "an authentication override",
      args: [
        "call",
        "youtube_transcript",
        "--input",
        '{"url":"https://youtu.be/id","access_key":"caller-key"}',
      ],
      message: "Unrecognized key",
    },
    {
      caseName: "a missing URL",
      args: ["call", "youtube_transcript", "--input", "{}"],
      message: "expected string",
    },
    {
      caseName: "full retrieval for a non-collection tool",
      args: [
        "call",
        "youtube_transcript",
        "--input",
        '{"url":"https://youtu.be/id"}',
        "--all",
      ],
      message: "requires an Okou Social collection tool",
    },
    {
      caseName: "a caller bound without full retrieval",
      args: [
        "call",
        "youtube_search",
        "--input",
        '{"query":"launch"}',
        "--max-pages",
        "2",
      ],
      message: "require --all",
    },
    {
      caseName: "an item bound for page-only retrieval",
      args: [
        "call",
        "instagram_reels_search",
        "--input",
        '{"query":"cats"}',
        "--all",
        "--max-items",
        "2",
      ],
      message: "requires a tool with a result limit",
    },
  ])("rejects $caseName before calling the API", async ({ args, message }) => {
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
      socialCommand.parseAsync(["node", "cli", ...args]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain(message);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(apiRequests).toBe(0);
  });

  it("prints API errors", async () => {
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        return HttpResponse.json(
          {
            error: {
              message: "SocialKit could not read the requested content",
              code: "SOCIALKIT_CONTENT_UNAVAILABLE",
            },
          },
          { status: 404 },
        );
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "cli",
        "call",
        "linkedin_profile",
        "--input",
        '{"url":"https://linkedin.com/in/example"}',
      ]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain(
      "404: Okou Social could not read the requested content",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it.each([
    {
      status: 404,
      code: "SOCIALKIT_TRANSCRIPT_UNAVAILABLE",
      message: "A transcript is not available for this video",
      title: "Transcript unavailable",
      guidance: "not evidence that the video contains no speech",
      reason: "transcript_unavailable",
    },
    {
      status: 404,
      code: "SOCIALKIT_TRANSCRIPT_AVAILABILITY_UNKNOWN",
      message:
        "SocialKit could not establish whether the source or transcript is unavailable",
      title: "Transcript availability unknown",
      guidance: "not evidence that the video contains no speech",
      reason: "availability_unknown",
    },
    {
      status: 502,
      code: "SOCIALKIT_TRANSCRIPT_ACCESS_DENIED",
      message:
        "SocialKit denied transcript access; transcript availability is unknown",
      title: "Transcript access denied",
      guidance: "not a vm0 authentication failure",
      reason: "access_denied",
    },
  ])("renders transcript guidance for $code", async (testCase) => {
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        return HttpResponse.json(
          {
            error: {
              message: testCase.message,
              code: testCase.code,
              reason: testCase.reason,
            },
          },
          { status: testCase.status },
        );
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "cli",
        "call",
        "youtube_transcript",
        "--input",
        '{"url":"https://youtu.be/example"}',
      ]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain(testCase.title);
    expect(errorOutput()).toContain(testCase.guidance);
    expect(errorOutput()).not.toMatch(/socialkit/iu);
    expect(errorOutput()).not.toContain("404:");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("uses public branding for a malformed API error", async () => {
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        return HttpResponse.json({}, { status: 502 });
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "cli",
        "call",
        "linkedin_profile",
        "--input",
        '{"url":"https://linkedin.com/in/example"}',
      ]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain("502: Okou Social request failed");
  });

  it("sanitizes download creation API errors", async () => {
    server.use(
      http.post("http://localhost:3000/api/social/downloads", () => {
        return HttpResponse.json(
          {
            error: {
              message: "SocialKit could not start the download",
              code: "SOCIALKIT_DOWNLOAD_FAILED",
            },
          },
          { status: 502 },
        );
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "cli",
        "download",
        "youtube",
        "https://youtu.be/public-video",
        "--max-duration",
        "600",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain(
      "502: Okou Social could not start the download",
    );
  });

  it("sanitizes download status API errors", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/social/downloads/6bdc3449-41ef-4624-a525-45bce09c67f0",
        () => {
          return HttpResponse.json(
            {
              error: {
                message: "SocialKit download status is unavailable",
                code: "SOCIALKIT_DOWNLOAD_FAILED",
              },
            },
            { status: 500 },
          );
        },
      ),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "cli",
        "download",
        "--resume",
        "6bdc3449-41ef-4624-a525-45bce09c67f0",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain(
      "500: Okou Social download status is unavailable",
    );
  });

  it("starts a download and prints its durable artifact", async () => {
    let submitted: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/downloads",
        async ({ request }) => {
          submitted = await request.json();
          return HttpResponse.json(
            {
              downloadId: "6bdc3449-41ef-4624-a525-45bce09c67f0",
              status: "completed",
              platform: "youtube",
              quality: "1080p",
              format: "mp4",
              maxDuration: 600,
              billingCategory: "request",
              provider: {
                durationSeconds: 61,
                fileSizeMB: 2,
                creditsCost: 2,
                title: "Public video",
              },
              billing: { quantity: 2, creditsCharged: 6 },
              artifact: {
                id: "6bdc3449-41ef-4624-a525-45bce09c67f0",
                url: "https://cdn.vm7.io/artifacts/social-video.mp4",
                filename: "Public video.mp4",
                contentType: "video/mp4",
                sizeBytes: 1024,
              },
              error: null,
              createdAt: "2026-08-27T00:00:00.000Z",
              completedAt: "2026-08-27T00:01:00.000Z",
            },
            { status: 202 },
          );
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "cli",
      "download",
      "youtube",
      "https://youtu.be/public-video",
      "--max-duration",
      "600",
      "--quality",
      "1080p",
      "--json",
    ]);

    expect(submitted).toStrictEqual({
      platform: "youtube",
      url: "https://youtu.be/public-video",
      maxDuration: 600,
      quality: "1080p",
      format: "mp4",
    });
    expect(JSON.parse(output()) as unknown).toMatchObject({
      status: "completed",
      billing: { quantity: 2, creditsCharged: 6 },
      artifact: { filename: "Public video.mp4" },
    });
    expect(errorOutput()).toContain("completed");
  });

  it("resumes a billed artifact failure without creating a new job", async () => {
    let createRequests = 0;
    let statusRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/downloads", () => {
        createRequests += 1;
        return HttpResponse.error();
      }),
      http.get(
        "http://localhost:3000/api/social/downloads/6bdc3449-41ef-4624-a525-45bce09c67f0",
        () => {
          statusRequests += 1;
          if (statusRequests === 1) {
            return HttpResponse.json(failedDownloadResponse("artifact_failed"));
          }
          return HttpResponse.json({
            downloadId: "6bdc3449-41ef-4624-a525-45bce09c67f0",
            status: "completed",
            platform: "youtube",
            quality: "720p",
            format: "mp4",
            maxDuration: 600,
            billingCategory: "request",
            provider: {
              durationSeconds: 60,
              fileSizeMB: 1,
              creditsCost: 1,
            },
            billing: { quantity: 1, creditsCharged: 3 },
            artifact: {
              id: "6bdc3449-41ef-4624-a525-45bce09c67f0",
              url: "https://cdn.vm7.io/artifacts/social-video.mp4",
              filename: "Public video.mp4",
              contentType: "video/mp4",
              sizeBytes: 1024,
            },
            error: null,
            createdAt: "2026-08-27T00:00:00.000Z",
            completedAt: "2026-08-27T00:01:00.000Z",
          });
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "cli",
      "download",
      "--resume",
      "6bdc3449-41ef-4624-a525-45bce09c67f0",
      "--json",
    ]);

    expect(createRequests).toBe(0);
    expect(statusRequests).toBe(2);
    expect(JSON.parse(output()) as unknown).toMatchObject({
      downloadId: "6bdc3449-41ef-4624-a525-45bce09c67f0",
      status: "completed",
    });
    expect(errorOutput()).toContain("artifact_failed");
  });

  it.each([
    {
      caseName: "a free provider failure",
      status: "provider_failed" as const,
      billed: "no",
      retryable: "no",
    },
    {
      caseName: "a billed artifact failure",
      status: "artifact_failed" as const,
      billed: "yes",
      retryable: "yes",
    },
  ])(
    "reports $caseName with complete diagnostics",
    async ({ status, billed, retryable }) => {
      server.use(
        http.post("http://localhost:3000/api/social/downloads", () => {
          return HttpResponse.json(failedDownloadResponse(status), {
            status: 202,
          });
        }),
      );

      await expect(
        socialCommand.parseAsync([
          "node",
          "cli",
          "download",
          "youtube",
          "https://youtu.be/public-video",
          "--max-duration",
          "600",
        ]),
      ).rejects.toThrow("process.exit called");

      const error = errorOutput();
      expect(error).toContain(
        "Download ID: 6bdc3449-41ef-4624-a525-45bce09c67f0",
      );
      expect(error).toContain(`Status: ${status}`);
      expect(error).toContain("Platform: youtube");
      expect(error).toContain("Requested quality: 720p");
      expect(error).toContain("Requested format: mp4");
      expect(error).toContain("Error code:");
      expect(error).toContain("Error:");
      expect(error).toContain(`Retryable: ${retryable}`);
      expect(error).toContain(`Billed: ${billed}`);
      if (status === "artifact_failed") {
        expect(error).toContain(
          "Resume: okou social download --resume 6bdc3449-41ef-4624-a525-45bce09c67f0",
        );
      } else {
        expect(error).not.toContain("Resume:");
      }
      expect(mockExit).toHaveBeenCalledWith(1);
    },
  );

  it("prints one compact terminal response for JSON failures", async () => {
    const response = {
      ...failedDownloadResponse("provider_failed"),
      error: {
        code: "SOCIALKIT_PROVIDER_duration_limit_exceeded",
        message: "Video exceeds the requested duration limit",
        retryable: false,
        billed: false,
      },
    };
    server.use(
      http.post("http://localhost:3000/api/social/downloads", () => {
        return HttpResponse.json(response, { status: 202 });
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "cli",
        "download",
        "youtube",
        "https://youtu.be/public-video",
        "--max-duration",
        "600",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    const publicResponse = {
      ...response,
      error: {
        ...response.error,
        code: "SOCIAL_PROVIDER_duration_limit_exceeded",
      },
    };
    expect(output()).toBe(JSON.stringify(publicResponse));
    expect(JSON.parse(output()) as unknown).toStrictEqual(publicResponse);
    expect(errorOutput()).toContain(
      "Error code: SOCIAL_PROVIDER_duration_limit_exceeded",
    );
    expect(errorOutput()).not.toMatch(/socialkit/iu);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("prints the exact corrected resume command for mixed arguments", async () => {
    await expect(
      socialCommand.parseAsync([
        "node",
        "cli",
        "download",
        "youtube",
        "https://youtu.be/public-video",
        "--resume",
        "6bdc3449-41ef-4624-a525-45bce09c67f0",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain(
      "use: okou social download --resume 6bdc3449-41ef-4624-a525-45bce09c67f0",
    );
  });

  it.each([
    {
      signal: "SIGINT" as const,
      secondSignal: "SIGTERM" as const,
      exitCode: 130,
    },
    {
      signal: "SIGTERM" as const,
      secondSignal: "SIGINT" as const,
      exitCode: 143,
    },
  ])(
    "prints recovery guidance and cleans up after $signal",
    async ({ signal, secondSignal, exitCode }) => {
      let statusRequestStarted = false;
      const initialSigintListeners = process.listenerCount("SIGINT");
      const initialSigtermListeners = process.listenerCount("SIGTERM");
      server.use(
        http.get(
          "http://localhost:3000/api/social/downloads/6bdc3449-41ef-4624-a525-45bce09c67f0",
          async ({ request }) => {
            statusRequestStarted = true;
            await new Promise<void>((resolve) => {
              if (request.signal.aborted) {
                resolve();
                return;
              }
              request.signal.addEventListener(
                "abort",
                () => {
                  resolve();
                },
                { once: true },
              );
            });
            return HttpResponse.error();
          },
        ),
      );

      const command = socialCommand.parseAsync([
        "node",
        "cli",
        "download",
        "--resume",
        "6bdc3449-41ef-4624-a525-45bce09c67f0",
        "--json",
      ]);
      await vi.waitFor(() => {
        expect(statusRequestStarted).toBeTruthy();
      });
      process.emit(signal, signal);
      process.emit(secondSignal, secondSignal);
      await command;

      expect(output()).toBe("");
      expect(mockConsoleError).toHaveBeenCalledTimes(2);
      expect(errorOutput()).toContain(
        `continues on the server after ${signal}`,
      );
      expect(errorOutput()).toContain(
        "Resume: okou social download --resume 6bdc3449-41ef-4624-a525-45bce09c67f0",
      );
      expect(process.exitCode).toBe(exitCode);
      expect(mockExit).not.toHaveBeenCalled();
      expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners);
      expect(process.listenerCount("SIGTERM")).toBe(initialSigtermListeners);
    },
  );

  it("documents typed discovery, calls, billing, and security boundaries", () => {
    const tools = socialCommand.commands.find((command) => {
      return command.name() === "tools";
    });
    const call = socialCommand.commands.find((command) => {
      return command.name() === "call";
    });
    let socialHelp = "";
    socialCommand.configureOutput({
      writeOut: (value) => {
        socialHelp += value;
      },
    });
    socialCommand.outputHelp();

    expect(tools?.helpInformation()).toContain("--json");
    expect(call?.helpInformation()).toContain("--input");
    expect(call?.helpInformation()).toContain("--all");
    expect(call?.helpInformation()).toContain("--max-pages");
    expect(call?.helpInformation()).toContain("--max-items");
    expect(call?.helpInformation()).toContain("--json");
    const download = socialCommand.commands.find((command) => {
      return command.name() === "download";
    });
    const downloadHelp = download?.helpInformation() ?? "";
    expect(socialHelp).toContain("Use Okou Social public data services");
    expect(tools?.helpInformation()).toContain(
      "List typed Okou Social tools and their schemas",
    );
    expect(call?.helpInformation()).toContain("Call a typed Okou Social tool");
    expect(downloadHelp).toContain("--max-duration");
    expect(downloadHelp).toContain("--resume");
    expect(downloadHelp).toContain("default: 720p");
    expect(downloadHelp).toContain("default: mp4");
    expect(downloadHelp.replace(/\s+/gu, " ")).toContain(
      "billing uses completed duration",
    );
    expect(socialHelp).toContain("38 typed tools");
    expect(socialHelp).toContain("okou social tools --json");
    expect(socialHelp).toContain("youtube_summarize");
    expect(socialHelp).toContain("okou social download youtube");
    expect(socialHelp).toContain("durable Okou artifacts");
    expect(socialHelp).toContain("Unknown bulk and direct-video tools");
    expect(socialHelp).toContain(
      "Full retrieval bills and emits each successful provider page independently",
    );
    expect(socialHelp).toContain(
      "Missing transcript data is not evidence that a video contains no speech",
    );
  });
});
