import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { listCommand } from "../list";
import { mkdtempSync } from "fs";
import { mkdir, rm } from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-zero-org-list-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => {
      return TEST_HOME;
    },
  };
});

function buildFakeCliJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = Buffer.from("fake-signature").toString("base64url");
  return `vm0_pat_${header}.${body}.${sig}`;
}

describe("zero org list command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(async () => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    const cliJwt = buildFakeCliJwt({
      scope: "cli",
      orgId: "my-org",
      userId: "user-1",
      tokenId: "tok-1",
    });
    vi.stubEnv("VM0_TOKEN", cliJwt);
    const configDir = path.join(TEST_HOME, ".vm0");
    await mkdir(configDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(path.join(TEST_HOME, ".vm0"), { recursive: true, force: true });
  });

  it("should display organizations with roles", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/org/list", () => {
        return HttpResponse.json({
          orgs: [
            { slug: "personal-user", role: "admin" },
            { slug: "my-org", role: "admin" },
          ],
          active: undefined,
        });
      }),
    );

    await listCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("personal-user");
    expect(logCalls).toContain("admin");
    expect(logCalls).toContain("my-org");
  });

  it("should mark current organization", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/org/list", () => {
        return HttpResponse.json({
          orgs: [
            { slug: "personal-user", role: "admin" },
            { slug: "my-org", role: "admin" },
          ],
          active: undefined,
        });
      }),
    );

    await listCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("current");
  });

  it("should handle API error", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/org/list", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Internal server error",
              code: "SERVER_ERROR",
            },
          },
          { status: 500 },
        );
      }),
    );

    await expect(async () => {
      await listCommand.parseAsync(["node", "cli"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Internal server error"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
