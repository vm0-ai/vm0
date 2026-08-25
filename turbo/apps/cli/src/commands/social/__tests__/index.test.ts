import { mkdtempSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { HttpResponse, http } from "msw";
import { socialKitRequestSchema } from "@okouai/api-contracts/contracts/social";
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

const responseBody = {
  provider: "socialkit",
  operation: { method: "GET", path: "/youtube/comments" },
  billingCategory: "request",
  billingQuantity: 1,
  creditsCharged: 3,
  collection: { state: "provider_limited", itemsReturned: 1 },
  result: {
    comments: [{ text: "Welcome to the comments." }],
  },
} as const;

describe("okou social command", () => {
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
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-zero-token");
    for (const command of socialCommand.commands) {
      command.setOptionValue("method", "GET");
      command.setOptionValue("query", undefined);
      command.setOptionValue("all", undefined);
      command.setOptionValue("maxPages", undefined);
      command.setOptionValue("maxItems", undefined);
      command.setOptionValue("json", undefined);
    }
  });

  afterEach(async () => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockStderrWrite.mockClear();
    mockExit.mockClear();
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

  it("posts a reviewed GET operation and prints compact JSON", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = (await request.json()) as unknown;
          return HttpResponse.json(responseBody);
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "cli",
      "request",
      "/youtube/comments",
      "--query",
      "url=https://youtu.be/video123",
      "--query",
      "limit=10",
      "--json",
    ]);

    expect(requestBody).toStrictEqual({
      method: "GET",
      path: "/youtube/comments",
      query: { url: "https://youtu.be/video123", limit: "10" },
    });
    expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(responseBody));
  });

  it("posts a reviewed operation and prints formatted JSON", async () => {
    let requestBody: unknown;
    const postResponse = {
      ...responseBody,
      operation: { method: "POST", path: "/youtube/stats" },
      collection: null,
      result: { views: 100 },
    } as const;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = (await request.json()) as unknown;
          return HttpResponse.json(postResponse);
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "cli",
      "request",
      "/youtube/stats",
      "-X",
      "post",
      "--query",
      "url=https://youtu.be/video123",
    ]);

    expect(requestBody).toStrictEqual({
      method: "POST",
      path: "/youtube/stats",
      query: { url: "https://youtu.be/video123" },
    });
    expect(output()).toBe(JSON.stringify(postResponse, null, 2));
  });

  it("retrieves cursor pages with provider-max page size and JSON Lines output", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          const body: unknown = await request.json();
          requests.push(body);
          const pageNumber = requests.length;
          return HttpResponse.json({
            ...responseBody,
            operation: { method: "GET", path: "/instagram/comments" },
            collection:
              pageNumber === 1
                ? {
                    state: "more",
                    itemsReturned: 2,
                    nextQuery: { cursor: "next-page" },
                  }
                : { state: "complete", itemsReturned: 1 },
            result: {
              comments: pageNumber === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }],
              hasMore: pageNumber === 1,
            },
          });
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "cli",
      "request",
      "/instagram/comments",
      "--query",
      "url=https://instagram.com/p/example",
      "--all",
      "--json",
    ]);

    expect(requests).toStrictEqual([
      {
        method: "GET",
        path: "/instagram/comments",
        query: {
          url: "https://instagram.com/p/example",
          limit: "100",
        },
      },
      {
        method: "GET",
        path: "/instagram/comments",
        query: {
          url: "https://instagram.com/p/example",
          limit: "100",
          cursor: "next-page",
        },
      },
    ]);
    const records = mockConsoleLog.mock.calls.map(([value]) => {
      return JSON.parse(String(value)) as unknown;
    });
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ kind: "page", pageNumber: 1 });
    expect(records[1]).toMatchObject({ kind: "page", pageNumber: 2 });
    expect(records[2]).toStrictEqual({
      kind: "summary",
      completion: "complete",
      pages: 2,
      itemsReturned: 3,
      billingQuantity: 2,
      creditsCharged: 6,
    });
  });

  it("follows numeric pages and reports the provider ceiling", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          const body: unknown = await request.json();
          requests.push(body);
          const pageNumber = requests.length;
          return HttpResponse.json({
            ...responseBody,
            operation: {
              method: "GET",
              path: "/instagram/reels-search",
            },
            collection:
              pageNumber === 1
                ? {
                    state: "more",
                    itemsReturned: 1,
                    nextQuery: { page: "2" },
                  }
                : { state: "provider_limited", itemsReturned: 1 },
            result: { items: [{ id: pageNumber }], hasMore: true },
          });
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "cli",
      "request",
      "/instagram/reels-search",
      "--query",
      "query=cats",
      "--all",
    ]);

    expect(requests).toStrictEqual([
      {
        method: "GET",
        path: "/instagram/reels-search",
        query: { query: "cats" },
      },
      {
        method: "GET",
        path: "/instagram/reels-search",
        query: { query: "cats", page: "2" },
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
    expect(output()).toContain("Page 1");
    expect(output()).toContain("Summary");
  });

  it("reports collections without provider continuation as limited", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = (await request.json()) as unknown;
          return HttpResponse.json({
            ...responseBody,
            operation: { method: "GET", path: "/youtube/search" },
            billingQuantity: 2,
            creditsCharged: 6,
            collection: { state: "provider_limited", itemsReturned: 100 },
            result: {
              results: Array.from({ length: 100 }, (_, id) => {
                return { id };
              }),
            },
          });
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "cli",
      "request",
      "/youtube/search",
      "--query",
      "query=launch",
      "--all",
      "--json",
    ]);

    expect(requestBody).toStrictEqual({
      method: "GET",
      path: "/youtube/search",
      query: { query: "launch", limit: "100" },
    });
    expect(JSON.parse(String(mockConsoleLog.mock.calls.at(-1)?.[0]))).toEqual({
      kind: "summary",
      completion: "provider_limited",
      pages: 1,
      itemsReturned: 100,
      billingQuantity: 2,
      creditsCharged: 6,
    });
  });

  it("stops at exact caller page and item limits", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          const body = socialKitRequestSchema.parse(await request.json());
          requests.push(body);
          const requestedLimit = Number(body.query?.limit);
          return HttpResponse.json({
            ...responseBody,
            operation: { method: "GET", path: "/tiktok/search" },
            collection: {
              state: "more",
              itemsReturned: requestedLimit,
              nextQuery: { cursor: `page-${requests.length + 1}` },
            },
            result: { results: [], hasMore: true },
          });
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "cli",
      "request",
      "/tiktok/search",
      "--query",
      "query=launch",
      "--all",
      "--max-pages",
      "1",
      "--json",
    ]);
    expect(requests).toHaveLength(1);
    expect(
      JSON.parse(String(mockConsoleLog.mock.calls.at(-1)?.[0])),
    ).toMatchObject({
      kind: "summary",
      completion: "caller_limited",
      pages: 1,
      itemsReturned: 100,
    });

    mockConsoleLog.mockClear();
    requests.length = 0;
    socialCommand.commands
      .find((command) => {
        return command.name() === "request";
      })
      ?.setOptionValue("maxPages", undefined);
    await socialCommand.parseAsync([
      "node",
      "cli",
      "request",
      "/tiktok/search",
      "--query",
      "query=launch",
      "--all",
      "--max-items",
      "3",
      "--json",
    ]);
    expect(requests).toStrictEqual([
      {
        method: "GET",
        path: "/tiktok/search",
        query: { query: "launch", limit: "3" },
      },
    ]);
    expect(
      JSON.parse(String(mockConsoleLog.mock.calls.at(-1)?.[0])),
    ).toMatchObject({
      kind: "summary",
      completion: "caller_limited",
      pages: 1,
      itemsReturned: 3,
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
        return HttpResponse.json({
          ...responseBody,
          operation: { method: "GET", path: "/tiktok/channel-videos" },
          collection: {
            state: "more",
            itemsReturned: 1,
            nextQuery: { cursor: "unstable-page" },
          },
          result: { results: [{ id: 1 }], hasMore: true },
        });
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "cli",
        "request",
        "/tiktok/channel-videos",
        "--query",
        "url=https://tiktok.com/@example",
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

  it("rejects repeated provider pagination without issuing another request", async () => {
    let requestCount = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        requestCount += 1;
        return HttpResponse.json({
          ...responseBody,
          operation: { method: "GET", path: "/tiktok/search" },
          collection: {
            state: "more",
            itemsReturned: 1,
            nextQuery: { cursor: "repeated-cursor" },
          },
          result: { results: [{ id: requestCount }], hasMore: true },
        });
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "cli",
        "request",
        "/tiktok/search",
        "--query",
        "query=launch",
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

  it.each([
    {
      caseName: "an unknown path",
      args: ["request", "/youtube/unknown"],
      message: "reviewed SocialKit operation",
    },
    {
      caseName: "a download path",
      args: ["request", "/youtube/download"],
      message: "reviewed SocialKit operation",
    },
    {
      caseName: "an authentication override",
      args: [
        "request",
        "/youtube/transcript",
        "--query",
        "access_key=caller-key",
      ],
      message: "not reviewed for this operation",
    },
    {
      caseName: "a bulk operation",
      args: ["request", "/youtube/stats/bulk", "-X", "POST"],
      message: "reviewed SocialKit operation",
    },
    {
      caseName: "a direct-video operation",
      args: ["request", "/video/transcript"],
      message: "reviewed SocialKit operation",
    },
  ])("rejects $caseName before calling the API", async ({ args, message }) => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        apiRequests += 1;
        return HttpResponse.json(responseBody);
      }),
    );

    await expect(
      socialCommand.parseAsync(["node", "cli", ...args]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain(message);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(apiRequests).toBe(0);
  });

  it("rejects duplicate query fields", async () => {
    await expect(
      socialCommand.parseAsync([
        "node",
        "cli",
        "request",
        "/youtube/search",
        "--query",
        "query=first",
        "--query",
        "query=second",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain("query is duplicated");
  });

  it.each([
    {
      caseName: "a caller page bound without full retrieval",
      args: [
        "request",
        "/youtube/search",
        "--query",
        "query=launch",
        "--max-pages",
        "2",
      ],
      message: "require --all",
    },
    {
      caseName: "full retrieval for a non-collection operation",
      args: [
        "request",
        "/youtube/transcript",
        "--query",
        "url=https://youtu.be/video123",
        "--all",
      ],
      message: "requires a SocialKit collection operation",
    },
    {
      caseName: "an item bound for page-only retrieval",
      args: [
        "request",
        "/instagram/reels-search",
        "--query",
        "query=cats",
        "--all",
        "--max-items",
        "2",
      ],
      message: "requires an operation with a result limit",
    },
  ])("rejects $caseName before calling the API", async ({ args, message }) => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        apiRequests += 1;
        return HttpResponse.json(responseBody);
      }),
    );

    await expect(
      socialCommand.parseAsync(["node", "cli", ...args]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain(message);
    expect(apiRequests).toBe(0);
  });

  it("prints API errors", async () => {
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        return HttpResponse.json(
          {
            error: {
              message: "The requested social content is unavailable",
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
        "request",
        "/linkedin/profile",
        "--query",
        "url=https://linkedin.com/in/example",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain(
      "404: The requested social content is unavailable",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("documents broad coverage, billing, and security boundaries", () => {
    const request = socialCommand.commands.find((command) => {
      return command.name() === "request";
    });
    let socialHelp = "";
    socialCommand.configureOutput({
      writeOut: (value) => {
        socialHelp += value;
      },
    });
    socialCommand.outputHelp();

    expect(request?.helpInformation()).toContain("--query");
    expect(request?.helpInformation()).toContain("--all");
    expect(request?.helpInformation()).toContain("--max-pages");
    expect(request?.helpInformation()).toContain("--max-items");
    expect(request?.helpInformation()).not.toContain("--body");
    expect(request?.helpInformation()).toContain("--json");
    expect(socialHelp).toContain("76 reviewed");
    expect(socialHelp).toContain("/youtube/summarize");
    expect(socialHelp).toContain(
      "download, bulk, and direct-video operations are rejected",
    );
    expect(socialHelp).toContain(
      "Full retrieval bills and emits each successful provider page independently",
    );
  });
});
