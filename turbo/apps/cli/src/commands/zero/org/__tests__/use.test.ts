import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { useCommand } from "../use";
import { mkdtempSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-zero-org-use-"));
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

describe("zero org use command", () => {
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

  it("should switch to a valid organization", async () => {
    const newJwt = buildFakeCliJwt({
      scope: "cli",
      orgId: "org-id-b",
      userId: "user-1",
      tokenId: "tok-1",
    });

    server.use(
      http.get("http://localhost:3000/api/zero/org/list", () => {
        return HttpResponse.json({
          orgs: [
            { slug: "org-a", role: "admin" },
            { slug: "org-b", role: "member" },
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

    await useCommand.parseAsync(["node", "cli", "org-b"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Switched to organization: org-b");
  });

  it("should error when organization not found", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/org/list", () => {
        return HttpResponse.json({
          orgs: [{ slug: "org-a", role: "admin" }],
          active: undefined,
        });
      }),
    );

    await expect(async () => {
      await useCommand.parseAsync(["node", "cli", "nonexistent"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("not found or not accessible"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should call org switch endpoint when using CLI JWT token", async () => {
    const cliJwt = buildFakeCliJwt({
      scope: "cli",
      orgId: "org-id-old",
      userId: "user-1",
      tokenId: "tok-1",
    });

    // Write JWT token to config file
    const configDir = path.join(TEST_HOME, ".vm0");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ token: cliJwt }),
    );

    // Clear env token so config file token is used
    vi.stubEnv("VM0_TOKEN", "");

    const newJwt = buildFakeCliJwt({
      scope: "cli",
      orgId: "org-id-new",
      userId: "user-1",
      tokenId: "tok-2",
    });

    server.use(
      http.get("http://localhost:3000/api/zero/org/list", () => {
        return HttpResponse.json({
          orgs: [
            { slug: "org-a", role: "admin" },
            { slug: "org-b", role: "member" },
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

    await useCommand.parseAsync(["node", "cli", "org-b"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Switched to organization: org-b");
  });
});
