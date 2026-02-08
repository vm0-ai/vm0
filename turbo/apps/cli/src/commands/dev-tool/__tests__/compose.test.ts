import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { composeCommand } from "../compose";

// Shared spies
const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("process.exit called");
}) as never);
const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
const mockConsoleError = vi
  .spyOn(console, "error")
  .mockImplementation(() => {});

describe("dev-tool compose command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("successful compose", () => {
    it("should create job and poll until completed", async () => {
      let pollCount = 0;

      server.use(
        // Create job
        http.post("http://localhost:3000/api/compose/from-github", () => {
          return HttpResponse.json(
            {
              jobId: "job-123",
              status: "pending",
              githubUrl: "https://github.com/owner/repo",
              createdAt: new Date().toISOString(),
            },
            { status: 201 },
          );
        }),
        // Poll status - return running twice, then completed
        http.get("http://localhost:3000/api/compose/from-github/:jobId", () => {
          pollCount++;
          if (pollCount < 3) {
            return HttpResponse.json({
              jobId: "job-123",
              status: "running",
              githubUrl: "https://github.com/owner/repo",
              createdAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json({
            jobId: "job-123",
            status: "completed",
            githubUrl: "https://github.com/owner/repo",
            result: {
              composeId: "cmp-123",
              composeName: "test-agent",
              versionId: "a".repeat(64),
              warnings: [],
            },
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          });
        }),
      );

      await expect(async () => {
        await composeCommand.parseAsync([
          "node",
          "cli",
          "https://github.com/owner/repo",
          "--interval",
          "0.1",
        ]);
      }).rejects.toThrow("process.exit called");

      // Should exit with 0 for success
      expect(mockExit).toHaveBeenCalledWith(0);

      // Should show success message
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose completed"),
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      server.use(
        http.post("http://localhost:3000/api/compose/from-github", () => {
          return HttpResponse.json(
            {
              jobId: "job-123",
              status: "pending",
              githubUrl: "https://github.com/owner/repo",
              createdAt: new Date().toISOString(),
            },
            { status: 201 },
          );
        }),
        http.get("http://localhost:3000/api/compose/from-github/:jobId", () => {
          return HttpResponse.json({
            jobId: "job-123",
            status: "completed",
            githubUrl: "https://github.com/owner/repo",
            result: {
              composeId: "cmp-123",
              composeName: "test-agent",
              versionId: "a".repeat(64),
              warnings: [],
            },
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          });
        }),
      );

      await expect(async () => {
        await composeCommand.parseAsync([
          "node",
          "cli",
          "https://github.com/owner/repo",
          "--json",
          "--interval",
          "0.1",
        ]);
      }).rejects.toThrow("process.exit called");

      // Find JSON output
      const jsonCall = mockConsoleLog.mock.calls.find((call) => {
        try {
          JSON.parse(call[0] as string);
          return true;
        } catch {
          return false;
        }
      });

      expect(jsonCall).toBeDefined();
      const result = JSON.parse(jsonCall![0] as string);
      expect(result.status).toBe("completed");
      expect(result.result.composeId).toBe("cmp-123");
    });
  });

  describe("failed compose", () => {
    it("should handle job failure", async () => {
      server.use(
        http.post("http://localhost:3000/api/compose/from-github", () => {
          return HttpResponse.json(
            {
              jobId: "job-123",
              status: "pending",
              githubUrl: "https://github.com/owner/repo",
              createdAt: new Date().toISOString(),
            },
            { status: 201 },
          );
        }),
        http.get("http://localhost:3000/api/compose/from-github/:jobId", () => {
          return HttpResponse.json({
            jobId: "job-123",
            status: "failed",
            githubUrl: "https://github.com/owner/repo",
            error: "vm0.yaml not found",
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          });
        }),
      );

      await expect(async () => {
        await composeCommand.parseAsync([
          "node",
          "cli",
          "https://github.com/owner/repo",
          "--interval",
          "0.1",
        ]);
      }).rejects.toThrow("process.exit called");

      // Should exit with 1 for failure
      expect(mockExit).toHaveBeenCalledWith(1);

      // Should show error message
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Compose failed"),
      );
    });

    it("should handle API errors", async () => {
      server.use(
        http.post("http://localhost:3000/api/compose/from-github", () => {
          return HttpResponse.json(
            {
              error: { message: "Invalid GitHub URL", code: "BAD_REQUEST" },
            },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await composeCommand.parseAsync([
          "node",
          "cli",
          "https://invalid-url.com/repo",
          "--interval",
          "0.1",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid GitHub URL"),
      );
    });
  });

  describe("timeout", () => {
    it("should timeout after specified duration", async () => {
      server.use(
        http.post("http://localhost:3000/api/compose/from-github", () => {
          return HttpResponse.json(
            {
              jobId: "job-123",
              status: "pending",
              githubUrl: "https://github.com/owner/repo",
              createdAt: new Date().toISOString(),
            },
            { status: 201 },
          );
        }),
        // Always return running
        http.get("http://localhost:3000/api/compose/from-github/:jobId", () => {
          return HttpResponse.json({
            jobId: "job-123",
            status: "running",
            githubUrl: "https://github.com/owner/repo",
            createdAt: new Date().toISOString(),
          });
        }),
      );

      await expect(async () => {
        await composeCommand.parseAsync([
          "node",
          "cli",
          "https://github.com/owner/repo",
          "--interval",
          "0.05",
          "--timeout",
          "0.1",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Timeout"),
      );
    });
  });

  describe("options", () => {
    it("should pass overwrite option to API", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/compose/from-github",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(
              {
                jobId: "job-123",
                status: "completed",
                githubUrl: "https://github.com/owner/repo",
                result: {
                  composeId: "cmp-123",
                  composeName: "test-agent",
                  versionId: "a".repeat(64),
                  warnings: [],
                },
                createdAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
              },
              { status: 201 },
            );
          },
        ),
        http.get("http://localhost:3000/api/compose/from-github/:jobId", () => {
          return HttpResponse.json({
            jobId: "job-123",
            status: "completed",
            githubUrl: "https://github.com/owner/repo",
            result: {
              composeId: "cmp-123",
              composeName: "test-agent",
              versionId: "a".repeat(64),
              warnings: [],
            },
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          });
        }),
      );

      await expect(async () => {
        await composeCommand.parseAsync([
          "node",
          "cli",
          "https://github.com/owner/repo",
          "--overwrite",
          "--interval",
          "0.1",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(capturedBody?.overwrite).toBe(true);
    });
  });
});
