import { mkdtempSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import chalk from "chalk";
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
  requestedUrl: "https://www.youtube.com/watch?v=video123",
  platform: "youtube",
  provider: "socialkit",
  billingCategory: "youtube.transcript",
  billingQuantity: 1,
  creditsCharged: 5,
  result: {
    transcript: "Welcome to the complete transcript.",
    transcriptSegments: [
      {
        text: "segment detail only",
        start: 0,
        duration: 1.5,
        timestamp: "00:00",
      },
    ],
    wordCount: 5,
    language: "en",
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
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-zero-token");
    for (const command of socialCommand.commands) {
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

  it("posts a normalized YouTube URL and prints complete JSON", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/okou/social/transcript",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(responseBody);
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "cli",
      "transcript",
      "https://www.youtube.com/watch?v=video123#captions",
      "--json",
    ]);

    expect(requestBody).toStrictEqual({
      url: "https://www.youtube.com/watch?v=video123",
    });
    expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(responseBody));
  });

  it("renders transcript metadata without duplicating segments", async () => {
    server.use(
      http.post("http://localhost:3000/api/okou/social/transcript", () => {
        return HttpResponse.json(responseBody);
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "cli",
      "transcript",
      "https://youtu.be/video123",
    ]);

    expect(output()).toContain("Social transcript completed");
    expect(output()).toContain("Platform: youtube");
    expect(output()).toContain("Provider: socialkit");
    expect(output()).toContain("Credits charged: 5");
    expect(output()).toContain("Word count: 5");
    expect(output()).toContain("Language: en");
    expect(output()).toContain("Welcome to the complete transcript.");
    expect(output()).not.toContain("segment detail only");
    expect(output()).not.toContain("00:00");
  });

  it.each([
    "https://example.com/watch?v=video123",
    "https://youtube.com/embed/video123",
    "https://user:password@youtube.com/watch?v=video123",
    "file:///tmp/video",
  ])("rejects unsupported URL %s before calling the API", async (url) => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/okou/social/transcript", () => {
        apiRequests += 1;
        return HttpResponse.json(responseBody);
      }),
    );

    await expect(
      socialCommand.parseAsync(["node", "cli", "transcript", url]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain("supported public YouTube");
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(apiRequests).toBe(0);
  });

  it("prints API errors", async () => {
    server.use(
      http.post("http://localhost:3000/api/okou/social/transcript", () => {
        return HttpResponse.json(
          {
            error: {
              message: "The YouTube transcript is unavailable",
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
        "transcript",
        "https://youtu.be/video123",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain(
      "404: The YouTube transcript is unavailable",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("documents timestamped JSON output", () => {
    const transcript = socialCommand.commands.find((command) => {
      return command.name() === "transcript";
    });
    let socialHelp = "";
    socialCommand.configureOutput({
      writeOut: (value) => {
        socialHelp += value;
      },
    });
    socialCommand.outputHelp();

    expect(transcript?.helpInformation()).toContain("timestamped segments");
    expect(transcript?.helpInformation()).toContain("--json");
    expect(socialHelp).toContain("vm0 credits");
    expect(socialHelp).toContain("submitted URL");
  });
});
