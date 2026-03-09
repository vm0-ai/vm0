import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { setCommand } from "../set";

describe("scope set command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  it("should exit with error if not authenticated", async () => {
    vi.stubEnv("VM0_TOKEN", "");
    vi.stubEnv("HOME", "/tmp/test-no-config");

    await expect(async () => {
      await setCommand.parseAsync(["node", "cli", "testslug"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Not authenticated"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should require --force to update existing scope", async () => {
    server.use(
      http.get("http://localhost:3000/api/scope", () => {
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
      expect.stringContaining("already have a scope: oldslug"),
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("--force"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should update scope with --force", async () => {
    server.use(
      http.get("http://localhost:3000/api/scope", () => {
        return HttpResponse.json({
          id: "test-id",
          slug: "oldslug",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        });
      }),
      http.put("http://localhost:3000/api/scope", () => {
        return HttpResponse.json({
          id: "test-id",
          slug: "newslug",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        });
      }),
    );

    await setCommand.parseAsync(["node", "cli", "newslug", "--force"]);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Scope updated to newslug"),
    );
  });

  it("should handle slug already taken", async () => {
    server.use(
      http.get("http://localhost:3000/api/scope", () => {
        return HttpResponse.json({
          id: "test-id",
          slug: "oldslug",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        });
      }),
      http.put("http://localhost:3000/api/scope", () => {
        return HttpResponse.json(
          { error: { message: "Scope already exists", code: "CONFLICT" } },
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
});
