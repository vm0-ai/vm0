import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { listCommand } from "../list";
import { mkdtempSync } from "fs";
import { mkdir, writeFile, rm } from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-zero-org-list-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return { ...original, homedir: () => TEST_HOME };
});

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
    vi.stubEnv("VM0_TOKEN", "test-token");
    vi.stubEnv("VM0_ACTIVE_ORG", "my-org");
    const configDir = path.join(TEST_HOME, ".vm0");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ activeOrg: "my-org" }),
    );
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
