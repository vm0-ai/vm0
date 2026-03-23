import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { useCommand } from "../use";
import { mkdtempSync } from "fs";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-zero-org-use-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return { ...original, homedir: () => TEST_HOME };
});

describe("zero org use command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  it("should switch to a valid organization", async () => {
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
});
