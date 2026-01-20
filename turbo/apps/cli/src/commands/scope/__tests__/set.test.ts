import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { setCommand } from "../set";
import * as config from "../../../lib/api/config";

// Mock the config module for auth
vi.mock("../../../lib/api/config", () => ({
  getApiUrl: vi.fn(),
  getToken: vi.fn(),
}));

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
    vi.mocked(config.getApiUrl).mockResolvedValue("http://localhost:3000");
    vi.mocked(config.getToken).mockResolvedValue("test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("authentication", () => {
    it("should exit with error if not authenticated", async () => {
      vi.mocked(config.getToken).mockResolvedValue(undefined);

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "testslug"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("create new scope", () => {
    it("should create scope successfully", async () => {
      server.use(
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(
            { error: { message: "No scope configured", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(
            {
              id: "test-id",
              slug: "testslug",
              type: "personal",
              displayName: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
      );

      await setCommand.parseAsync(["node", "cli", "testslug"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Scope created: testslug"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("testslug/<image-name>"),
      );
    });

    it("should create scope with display name", async () => {
      let capturedBody: unknown;
      server.use(
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(
            { error: { message: "No scope configured", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/scope", async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json(
            {
              id: "test-id",
              slug: "testslug",
              type: "personal",
              displayName: "Test Display",
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
            { status: 201 },
          );
        }),
      );

      await setCommand.parseAsync([
        "node",
        "cli",
        "testslug",
        "--display-name",
        "Test Display",
      ]);

      expect(capturedBody).toEqual({
        slug: "testslug",
        displayName: "Test Display",
      });
    });
  });

  describe("update existing scope", () => {
    it("should require --force to update existing scope", async () => {
      server.use(
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json({
            id: "test-id",
            slug: "oldslug",
            type: "personal",
            displayName: null,
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
            type: "personal",
            displayName: null,
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
          });
        }),
        http.put("http://localhost:3000/api/scope", () => {
          return HttpResponse.json({
            id: "test-id",
            slug: "newslug",
            type: "personal",
            displayName: null,
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
  });

  describe("error handling", () => {
    it("should handle slug already taken", async () => {
      server.use(
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(
            { error: { message: "No scope configured", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(
            { error: { message: "Scope already exists", code: "CONFLICT" } },
            { status: 409 },
          );
        }),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "takenslug"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("already taken"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle reserved slug", async () => {
      server.use(
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(
            { error: { message: "No scope configured", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(
            {
              error: {
                message: 'Scope slug "vm0" is reserved',
                code: "FORBIDDEN",
              },
            },
            { status: 403 },
          );
        }),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "vm0"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("reserved"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle vm0 prefix rejection", async () => {
      server.use(
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(
            { error: { message: "No scope configured", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(
            {
              error: {
                message: 'Scope slug "vm0test" is reserved',
                code: "FORBIDDEN",
              },
            },
            { status: 403 },
          );
        }),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "vm0test"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("reserved"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle unexpected errors", async () => {
      server.use(
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(
            { error: { message: "No scope configured", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(
            {
              error: { message: "Unexpected error", code: "SERVER_ERROR" },
            },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "testslug"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unexpected error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle non-Error exceptions", async () => {
      server.use(
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(
            { error: { message: "No scope configured", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/scope", () => {
          return HttpResponse.error();
        }),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "testslug"]);
      }).rejects.toThrow("process.exit called");

      // Network error from HttpResponse.error() manifests as "Failed to fetch"
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
