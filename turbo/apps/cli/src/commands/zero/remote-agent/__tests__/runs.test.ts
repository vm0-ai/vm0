import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";

import { server } from "../../../../mocks/server";
import { runsCommand } from "../runs";

const runListItem = {
  id: "job-123",
  hostId: "host-123",
  hostName: "laptop",
  backend: "codex",
  prompt: "summarize logs",
  status: "succeeded",
  exitCode: 0,
  createdAt: "2026-05-12T10:00:00Z",
  startedAt: "2026-05-12T10:00:01Z",
  completedAt: "2026-05-12T10:00:10Z",
};

const runDetail = {
  ...runListItem,
  output: "done",
  error: null,
};

describe("remote-agent runs command", () => {
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
    process.exitCode = undefined;
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("lists remote-agent runs in table format", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/remote-agent/runs", () => {
        return HttpResponse.json({ runs: [runListItem] });
      }),
    );

    await runsCommand.parseAsync(["node", "cli", "list"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("JOB ID");
    expect(logCalls).toContain("job-123");
    expect(logCalls).toContain("laptop");
    expect(logCalls).toContain("succeeded");
    expect(logCalls).toContain("summarize logs");
  });

  it("passes list filters to the API", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get(
        "http://localhost:3000/api/zero/remote-agent/runs",
        ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ runs: [] });
        },
      ),
    );

    await runsCommand.parseAsync([
      "node",
      "cli",
      "list",
      "--status",
      "running",
      "--host",
      "laptop",
      "--limit",
      "10",
    ]);

    expect(capturedUrl?.searchParams.get("status")).toBe("running");
    expect(capturedUrl?.searchParams.get("hostName")).toBe("laptop");
    expect(capturedUrl?.searchParams.get("limit")).toBe("10");
  });

  it("prints list JSON", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/remote-agent/runs", () => {
        return HttpResponse.json({ runs: [runListItem] });
      }),
    );

    await runsCommand.parseAsync(["node", "cli", "list", "--json"]);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      JSON.stringify({ runs: [runListItem] }),
    );
  });

  it("shows remote-agent run status", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/remote-agent/run/:id", () => {
        return HttpResponse.json(runDetail);
      }),
    );

    await runsCommand.parseAsync(["node", "cli", "status", "job-123"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Job: job-123");
    expect(logCalls).toContain("Status: succeeded");
    expect(logCalls).toContain("Backend: codex");
  });

  it("prints a succeeded remote-agent run result", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/remote-agent/run/:id", () => {
        return HttpResponse.json(runDetail);
      }),
    );

    await runsCommand.parseAsync(["node", "cli", "result", "job-123"]);

    expect(mockConsoleLog).toHaveBeenCalledWith("done");
  });

  it("fails result lookup for an active remote-agent run", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/remote-agent/run/:id", () => {
        return HttpResponse.json({
          ...runDetail,
          status: "running",
          output: null,
          completedAt: null,
          exitCode: null,
        });
      }),
    );

    await expect(async () => {
      await runsCommand.parseAsync(["node", "cli", "result", "job-123"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Remote-agent job is running"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("prints failed result errors and sets exit code", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/remote-agent/run/:id", () => {
        return HttpResponse.json({
          ...runDetail,
          status: "failed",
          output: null,
          error: "boom",
          exitCode: 42,
        });
      }),
    );

    await runsCommand.parseAsync(["node", "cli", "result", "job-123"]);

    expect(mockConsoleError).toHaveBeenCalledWith("boom");
    expect(process.exitCode).toBe(42);
  });
});
