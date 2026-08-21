import { mkdtempSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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
  result: {
    transcript: "Welcome to the complete transcript.",
    transcriptSegments: [{ text: "segment detail", start: 0, duration: 1.5 }],
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
        "http://localhost:3000/api/okou/social/request",
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
      result: { views: 100 },
    } as const;
    server.use(
      http.post(
        "http://localhost:3000/api/okou/social/request",
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
      http.post("http://localhost:3000/api/okou/social/request", () => {
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

  it("prints API errors", async () => {
    server.use(
      http.post("http://localhost:3000/api/okou/social/request", () => {
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
    expect(request?.helpInformation()).not.toContain("--body");
    expect(request?.helpInformation()).toContain("--json");
    expect(socialHelp).toContain("76 fixed-cost");
    expect(socialHelp).toContain("/youtube/summarize");
    expect(socialHelp).toContain(
      "download, bulk, and direct-video operations are rejected",
    );
  });
});
