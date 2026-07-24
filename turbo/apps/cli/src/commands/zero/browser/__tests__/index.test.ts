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

import { server } from "../../../../mocks/server";
import { zeroBrowserCommand } from "../index";

const spawnSyncMock = vi.hoisted(() => {
  return vi.fn();
});
vi.mock("node:child_process", () => {
  return { spawnSync: spawnSyncMock };
});

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "zero-browser-home-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => {
      return TEST_HOME;
    },
  };
});

const THREAD_ID = "c0000000-0000-4000-a000-000000000010";
const BROWSER_ID = "c0000000-0000-4000-a000-000000000011";
const CDP_URL = "wss://connect.browser-use.com/?token=secret-cdp-token";

function browser(status: "active" | "suspended" = "active") {
  return {
    id: BROWSER_ID,
    name: "booking",
    status,
    viewerUrl: `https://app.vm0.ai/browsers/${BROWSER_ID}`,
    liveUrl:
      status === "active"
        ? "https://live.browser-use.com/?wss=secret-live-token"
        : null,
    proxyCountryCode: null,
    timeoutMinutes: 30,
    maxCredits: 500,
    grossCredits: 0,
    creditsCharged: 0,
    suspendedAt: status === "suspended" ? "2026-07-24T10:05:00.000Z" : null,
    suspensionReason: status === "suspended" ? ("run_end" as const) : null,
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
  } as const;
}

describe("zero browser command", () => {
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const processExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(async () => {
    await fs.rm(path.join(TEST_HOME, ".vm0"), {
      recursive: true,
      force: true,
    });
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
    vi.stubEnv("ZERO_CHAT_THREAD_ID", THREAD_ID);
    spawnSyncMock.mockReturnValue({ status: 0 });
  });

  afterEach(async () => {
    consoleLog.mockClear();
    consoleError.mockClear();
    processExit.mockClear();
    spawnSyncMock.mockReset();
    vi.unstubAllEnvs();
    await fs.rm(path.join(TEST_HOME, ".vm0"), {
      recursive: true,
      force: true,
    });
  });

  afterAll(async () => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
    processExit.mockRestore();
    await fs.rm(TEST_HOME, { recursive: true, force: true });
  });

  it("exposes only resume, new, status, and view lifecycle commands", () => {
    expect(
      zeroBrowserCommand.commands.map((command) => {
        return command.name();
      }),
    ).toStrictEqual(["resume", "new", "status", "view"]);
  });

  it("creates a fresh browser and passes its CDP URL directly to agent-browser", async () => {
    let requestBody: unknown;
    let authorization: string | null = null;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/browsers",
        async ({ request }) => {
          requestBody = await request.json();
          authorization = request.headers.get("authorization");
          return HttpResponse.json(
            { browser: browser(), cdpUrl: CDP_URL },
            { status: 201 },
          );
        },
      ),
    );

    await zeroBrowserCommand.parseAsync([
      "node",
      "cli",
      "new",
      "--name",
      "booking",
    ]);

    expect(requestBody).toStrictEqual({
      name: "booking",
      proxyCountryCode: null,
      timeoutMinutes: 30,
      maxCredits: 500,
    });
    expect(authorization).toBe("Bearer test-zero-token");
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "agent-browser",
      ["--session", "zero-browser", "connect", CDP_URL],
      { stdio: "ignore" },
    );
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(
      `[Open live browser](https://app.vm0.ai/browsers/${BROWSER_ID})`,
    );
    expect(output).not.toContain(CDP_URL);
  });

  it("resumes the thread browser without exposing a stop endpoint", async () => {
    let resumeRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/zero/browsers/resume", () => {
        resumeRequests += 1;
        return HttpResponse.json(
          { browser: browser("active"), cdpUrl: CDP_URL },
          { status: 200 },
        );
      }),
    );

    await zeroBrowserCommand.parseAsync(["node", "cli", "resume"]);

    expect(resumeRequests).toBe(1);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "agent-browser",
      ["--session", "zero-browser", "connect", CDP_URL],
      { stdio: "ignore" },
    );
  });

  it("keeps provider connection URLs out of JSON output", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/browsers", () => {
        return HttpResponse.json(
          { browser: browser(), cdpUrl: CDP_URL },
          { status: 201 },
        );
      }),
    );

    await zeroBrowserCommand.parseAsync([
      "node",
      "cli",
      "new",
      "--name",
      "booking",
      "--json",
    ]);

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "agent-browser",
      ["--session", "zero-browser", "connect", CDP_URL],
      { stdio: "ignore" },
    );
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).not.toContain("secret-cdp-token");
    expect(output).not.toContain("secret-live-token");
    expect(JSON.parse(output)).toMatchObject({
      browser: {
        id: BROWSER_ID,
        viewerUrl: `https://app.vm0.ai/browsers/${BROWSER_ID}`,
      },
      agentBrowserSession: "zero-browser",
    });
  });
});
