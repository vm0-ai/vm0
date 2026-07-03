import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { leaveCommand } from "../leave";
import { mkdtempSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-zero-org-leave-"));
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

describe("zero org leave command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  it("should leave org and auto-switch to remaining org", async () => {
    const newJwt = buildFakeCliJwt({
      scope: "cli",
      orgId: "org-id-other",
      userId: "user-1",
      tokenId: "tok-1",
    });

    server.use(
      http.post("http://localhost:3000/api/zero/org/leave", () => {
        return HttpResponse.json({
          message: "Left organization",
        });
      }),
      http.get("http://localhost:3000/api/zero/org/list", () => {
        return HttpResponse.json({
          orgs: [
            { slug: "other-org", role: "member" },
            { slug: "another-org", role: "admin" },
          ],
          active: undefined,
        });
      }),
      http.post("http://localhost:3000/api/cli/auth/org", () => {
        return HttpResponse.json({
          access_token: newJwt,
          token_type: "Bearer",
          expires_in: 7776000,
        });
      }),
    );

    await leaveCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Left organization");
    expect(logCalls).toContain("Switched to: other-org");
  });

  it("should handle no remaining organizations after leaving", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/org/leave", () => {
        return HttpResponse.json({
          message: "Left organization",
        });
      }),
      http.get("http://localhost:3000/api/zero/org/list", () => {
        return HttpResponse.json({
          orgs: [],
          active: undefined,
        });
      }),
    );

    await leaveCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Left organization");
    expect(logCalls).toContain("No remaining organizations");
  });

  it("should handle admin-cannot-leave error", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/org/leave", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Admin cannot leave the organization",
              code: "FORBIDDEN",
            },
          },
          { status: 403 },
        );
      }),
    );

    await expect(async () => {
      await leaveCommand.parseAsync(["node", "cli"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Admin cannot leave"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should call org switch endpoint when leaving with JWT token", async () => {
    const cliJwt = buildFakeCliJwt({
      scope: "cli",
      orgId: "org-id-old",
      userId: "user-1",
      tokenId: "tok-1",
    });

    const configDir = path.join(TEST_HOME, ".vm0");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ token: cliJwt }),
    );
    vi.stubEnv("VM0_TOKEN", "");

    const newJwt = buildFakeCliJwt({
      scope: "cli",
      orgId: "org-id-next",
      userId: "user-1",
      tokenId: "tok-2",
    });

    server.use(
      http.post("http://localhost:3000/api/zero/org/leave", () => {
        return HttpResponse.json({ message: "Left organization" });
      }),
      http.get("http://localhost:3000/api/zero/org/list", () => {
        return HttpResponse.json({
          orgs: [{ slug: "next-org", role: "admin" }],
          active: undefined,
        });
      }),
      http.post("http://localhost:3000/api/cli/auth/org", () => {
        return HttpResponse.json({
          access_token: newJwt,
          token_type: "Bearer",
          expires_in: 7776000,
        });
      }),
    );

    await leaveCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Left organization");
    expect(logCalls).toContain("Switched to: next-org");
  });
});
