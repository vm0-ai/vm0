import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { setCommand } from "../set";
import { mkdtempSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-zero-org-set-"));
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

describe("zero org set command", () => {
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

  it("should require --force to update existing organization", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/org", () => {
        return HttpResponse.json({
          id: "test-id",
          slug: "oldslug",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        });
      }),
    );

    await expect(async () => {
      await setCommand.parseAsync(["node", "cli", "newslug"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("already have an organization: oldslug"),
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("--force"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should update organization with --force", async () => {
    const newJwt = buildFakeCliJwt({
      scope: "cli",
      orgId: "org-id-new",
      userId: "user-1",
      tokenId: "tok-1",
    });

    server.use(
      http.get("http://localhost:3000/api/zero/org", () => {
        return HttpResponse.json({
          id: "test-id",
          slug: "oldslug",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        });
      }),
      http.put("http://localhost:3000/api/zero/org", () => {
        return HttpResponse.json({
          id: "test-id",
          slug: "newslug",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
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

    await setCommand.parseAsync(["node", "cli", "newslug", "--force"]);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Organization updated to newslug"),
    );
  });

  it("should handle slug already taken", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/org", () => {
        return HttpResponse.json({
          id: "test-id",
          slug: "oldslug",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        });
      }),
      http.put("http://localhost:3000/api/zero/org", () => {
        return HttpResponse.json(
          { error: { message: "Org already exists", code: "CONFLICT" } },
          { status: 409 },
        );
      }),
    );

    await expect(async () => {
      await setCommand.parseAsync(["node", "cli", "takenslug", "--force"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("already taken"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should call org switch endpoint after rename with JWT token", async () => {
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
      orgId: "org-id-new",
      userId: "user-1",
      tokenId: "tok-2",
    });

    server.use(
      http.get("http://localhost:3000/api/zero/org", () => {
        return HttpResponse.json({
          id: "test-id",
          slug: "oldslug",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        });
      }),
      http.put("http://localhost:3000/api/zero/org", () => {
        return HttpResponse.json({
          id: "test-id",
          slug: "newslug",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
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

    await setCommand.parseAsync(["node", "cli", "newslug", "--force"]);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Organization updated to newslug"),
    );
  });
});
