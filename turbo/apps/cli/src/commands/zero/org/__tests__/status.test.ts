import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { statusCommand } from "../status";

describe("zero org status command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("should display organization information", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/org", () => {
        return HttpResponse.json({
          id: "test-id",
          slug: "testuser",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        });
      }),
    );

    await statusCommand.parseAsync(["node", "cli"]);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Organization Information"),
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("testuser"),
    );
  });

  it("should show helpful message when user has no organization", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/org", () => {
        return HttpResponse.json(
          { error: { message: "No org configured", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
    );

    await expect(async () => {
      await statusCommand.parseAsync(["node", "cli"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("No organization configured"),
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("zero org set"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should handle server errors", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/org", () => {
        return HttpResponse.json(
          { error: { message: "Server error", code: "SERVER_ERROR" } },
          { status: 500 },
        );
      }),
    );

    await expect(async () => {
      await statusCommand.parseAsync(["node", "cli"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Server error"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
