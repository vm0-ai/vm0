import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { listCommand } from "../list";
import chalk from "chalk";

function buildFakeZeroJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = Buffer.from("fake-signature").toString("base64url");
  return `vm0_sandbox_${header}.${body}.${sig}`;
}

describe("zero org list command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    const zeroJwt = buildFakeZeroJwt({
      scope: "zero",
      orgId: "my-org",
      userId: "user-1",
      runId: "run-1",
      capabilities: [],
    });
    vi.stubEnv("ZERO_TOKEN", zeroJwt);
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
