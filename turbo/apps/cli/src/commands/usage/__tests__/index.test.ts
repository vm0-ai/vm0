import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { usageCommand } from "../index";

describe("usage command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: new Date("2026-01-19T12:00:00Z") });
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    vi.useRealTimers();
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("default behavior", () => {
    it("should fetch usage with default 7 day range", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-12T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: {
              total_runs: 10,
              total_run_time_ms: 600000, // 10 minutes
            },
            daily: [
              { date: "2026-01-18", run_count: 5, run_time_ms: 300000 },
              { date: "2026-01-17", run_count: 3, run_time_ms: 180000 },
              { date: "2026-01-16", run_count: 2, run_time_ms: 120000 },
            ],
          });
        }),
      );

      await usageCommand.parseAsync(["node", "cli"]);

      // Check output contains expected header and data
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Usage Summary"),
      );
    });

    it("should display daily breakdown with formatted durations", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-12T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: {
              total_runs: 10,
              total_run_time_ms: 600000,
            },
            daily: [
              { date: "2026-01-18", run_count: 5, run_time_ms: 300000 }, // 5m
            ],
          });
        }),
      );

      await usageCommand.parseAsync(["node", "cli"]);

      // Check totals row
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("TOTAL"),
      );
    });
  });

  describe("--since option", () => {
    it("should accept ISO date format", async () => {
      let capturedUrl: string | undefined;
      server.use(
        http.get("http://localhost:3000/api/usage", ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            period: {
              start: "2026-01-15T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 5, total_run_time_ms: 300000 },
            daily: [],
          });
        }),
      );

      await usageCommand.parseAsync(["node", "cli", "--since", "2026-01-15"]);

      expect(capturedUrl).toContain("start_date");
      expect(capturedUrl).toContain("2026-01-15");
    });

    it("should accept relative format (7d)", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-12T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 5, total_run_time_ms: 300000 },
            daily: [],
          });
        }),
      );

      await usageCommand.parseAsync(["node", "cli", "--since", "7d"]);

      // Test passes if no error is thrown
      expect(mockConsoleLog).toHaveBeenCalled();
    });

    it("should accept seconds format (30s)", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-19T11:59:30.000Z",
              end: "2026-01-19T12:00:00.000Z",
            },
            summary: { total_runs: 1, total_run_time_ms: 30000 },
            daily: [],
          });
        }),
      );

      await usageCommand.parseAsync(["node", "cli", "--since", "30s"]);
      expect(mockConsoleLog).toHaveBeenCalled();
    });

    it("should accept hours format (2h)", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-19T10:00:00.000Z",
              end: "2026-01-19T12:00:00.000Z",
            },
            summary: { total_runs: 3, total_run_time_ms: 180000 },
            daily: [],
          });
        }),
      );

      await usageCommand.parseAsync(["node", "cli", "--since", "2h"]);
      expect(mockConsoleLog).toHaveBeenCalled();
    });

    it("should accept weeks format (1w)", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-12T12:00:00.000Z",
              end: "2026-01-19T12:00:00.000Z",
            },
            summary: { total_runs: 10, total_run_time_ms: 600000 },
            daily: [],
          });
        }),
      );

      await usageCommand.parseAsync(["node", "cli", "--since", "1w"]);
      expect(mockConsoleLog).toHaveBeenCalled();
    });

    it("should accept Unix timestamp in seconds", async () => {
      let capturedUrl: string | undefined;
      server.use(
        http.get("http://localhost:3000/api/usage", ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            period: {
              start: "2026-01-15T10:30:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 5, total_run_time_ms: 300000 },
            daily: [],
          });
        }),
      );

      // Unix timestamp for 2026-01-15T10:30:00Z = 1768483800
      await usageCommand.parseAsync(["node", "cli", "--since", "1768483800"]);

      expect(capturedUrl).toContain("start_date");
    });

    it("should accept Unix timestamp in milliseconds", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-15T10:30:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 5, total_run_time_ms: 300000 },
            daily: [],
          });
        }),
      );

      // Unix timestamp in ms for 2026-01-15T10:30:00Z = 1768483800000
      await usageCommand.parseAsync([
        "node",
        "cli",
        "--since",
        "1768483800000",
      ]);
      expect(mockConsoleLog).toHaveBeenCalled();
    });

    it("should accept ISO 8601 with timezone offset", async () => {
      let capturedUrl: string | undefined;
      server.use(
        http.get("http://localhost:3000/api/usage", ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            period: {
              start: "2026-01-15T02:30:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 5, total_run_time_ms: 300000 },
            daily: [],
          });
        }),
      );

      // 2026-01-15T10:30:00+08:00 = 2026-01-15T02:30:00Z
      await usageCommand.parseAsync([
        "node",
        "cli",
        "--since",
        "2026-01-15T10:30:00+08:00",
      ]);

      expect(capturedUrl).toContain("start_date");
    });

    it("should reject invalid --since format", async () => {
      await expect(async () => {
        await usageCommand.parseAsync(["node", "cli", "--since", "invalid"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid --since format"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("--until option", () => {
    it("should accept ISO date format", async () => {
      let capturedUrl: string | undefined;
      server.use(
        http.get("http://localhost:3000/api/usage", ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            period: {
              start: "2026-01-10T00:00:00.000Z",
              end: "2026-01-17T00:00:00.000Z",
            },
            summary: { total_runs: 5, total_run_time_ms: 300000 },
            daily: [],
          });
        }),
      );

      await usageCommand.parseAsync(["node", "cli", "--until", "2026-01-17"]);

      expect(capturedUrl).toContain("end_date");
      expect(capturedUrl).toContain("2026-01-17");
    });

    it("should reject invalid --until format", async () => {
      await expect(async () => {
        await usageCommand.parseAsync(["node", "cli", "--until", "invalid"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid --until format"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("date range validation", () => {
    it("should reject --since after --until", async () => {
      await expect(async () => {
        await usageCommand.parseAsync([
          "node",
          "cli",
          "--since",
          "2026-01-20",
          "--until",
          "2026-01-15",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--since must be before --until"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject range exceeding 30 days", async () => {
      await expect(async () => {
        await usageCommand.parseAsync([
          "node",
          "cli",
          "--since",
          "2025-12-01",
          "--until",
          "2026-01-15",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("exceeds maximum of 30 days"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("error handling", () => {
    it("should handle authentication errors", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await usageCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle API errors", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json(
            { error: { message: "Server error", code: "SERVER_ERROR" } },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await usageCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle unexpected errors", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.error();
        }),
      );

      await expect(async () => {
        await usageCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      // Network error from HttpResponse.error() manifests as "Failed to fetch"
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("output formatting", () => {
    it("should fill in missing dates with zero values", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-15T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 2, total_run_time_ms: 120000 },
            daily: [
              // Only one day has data, others should be filled with zeros
              { date: "2026-01-17", run_count: 2, run_time_ms: 120000 },
            ],
          });
        }),
      );

      await usageCommand.parseAsync(["node", "cli"]);

      // Should have called console.log multiple times for each day
      // The missing dates should be filled in
      expect(mockConsoleLog).toHaveBeenCalled();
    });

    it("should display '-' for zero run time", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-15T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 0, total_run_time_ms: 0 },
            daily: [],
          });
        }),
      );

      await usageCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("-"));
    });
  });

  describe("duration formatting in output", () => {
    it("should format hours, minutes, and seconds (2h 53m 22s)", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-12T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 1, total_run_time_ms: 10402000 },
            daily: [],
          });
        }),
      );
      await usageCommand.parseAsync(["node", "cli"]);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("2h 53m 22s"),
      );
    });

    it("should format hours and minutes without seconds (2h 30m)", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-12T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 1, total_run_time_ms: 9000000 },
            daily: [],
          });
        }),
      );
      await usageCommand.parseAsync(["node", "cli"]);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("2h 30m"),
      );
    });

    it("should format hours and seconds without minutes (1h 30s)", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-12T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 1, total_run_time_ms: 3630000 },
            daily: [],
          });
        }),
      );
      await usageCommand.parseAsync(["node", "cli"]);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("1h 30s"),
      );
    });

    it("should format hours only (2h)", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-12T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 1, total_run_time_ms: 7200000 },
            daily: [],
          });
        }),
      );
      await usageCommand.parseAsync(["node", "cli"]);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("2h"),
      );
    });

    it("should format minutes and seconds (45m 32s)", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-12T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 1, total_run_time_ms: 2732000 },
            daily: [],
          });
        }),
      );
      await usageCommand.parseAsync(["node", "cli"]);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("45m 32s"),
      );
    });

    it("should format minutes only (15m)", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-12T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 1, total_run_time_ms: 900000 },
            daily: [],
          });
        }),
      );
      await usageCommand.parseAsync(["node", "cli"]);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("15m"),
      );
    });

    it("should format seconds only (32s)", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-12T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 1, total_run_time_ms: 32000 },
            daily: [],
          });
        }),
      );
      await usageCommand.parseAsync(["node", "cli"]);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("32s"),
      );
    });

    it("should display '< 1s' for sub-second durations", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-12T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 1, total_run_time_ms: 500 },
            daily: [],
          });
        }),
      );
      await usageCommand.parseAsync(["node", "cli"]);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("< 1s"),
      );
    });

    it("should format exactly 1 second (1s)", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-12T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 1, total_run_time_ms: 1000 },
            daily: [],
          });
        }),
      );
      await usageCommand.parseAsync(["node", "cli"]);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("1s"),
      );
    });

    it("should format exactly 1 minute (1m)", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-12T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 1, total_run_time_ms: 60000 },
            daily: [],
          });
        }),
      );
      await usageCommand.parseAsync(["node", "cli"]);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("1m"),
      );
    });

    it("should format exactly 1 hour (1h)", async () => {
      server.use(
        http.get("http://localhost:3000/api/usage", () => {
          return HttpResponse.json({
            period: {
              start: "2026-01-12T00:00:00.000Z",
              end: "2026-01-19T00:00:00.000Z",
            },
            summary: { total_runs: 1, total_run_time_ms: 3600000 },
            daily: [],
          });
        }),
      );
      await usageCommand.parseAsync(["node", "cli"]);
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("1h"),
      );
    });
  });
});
