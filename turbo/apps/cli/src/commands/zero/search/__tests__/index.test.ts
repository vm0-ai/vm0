/**
 * Tests for zero search command scaffold (#10244).
 *
 * Entry point: zeroSearchCommand.parseAsync()
 * Mock (external): none — no API calls in the scaffold
 * Real (internal): all CLI validation and help wiring
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { zeroSearchCommand, SEARCH_EXPLAINER } from "../index";

describe("zero search command (scaffold)", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    // Commander retains parsed option state across parseAsync calls on the
    // same Command instance. Reset the collector value before each test so
    // ordering does not leak state between cases.
    zeroSearchCommand.setOptionValue("source", []);
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("prints the explainer and exits 0 when --source is omitted", async () => {
    await zeroSearchCommand.parseAsync(["node", "cli", "hello"]);

    expect(mockExit).not.toHaveBeenCalled();
    const logs = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logs).toContain("Available sources:");
    expect(logs).toContain("logs   full agent event stream");
    expect(logs).toContain("chat   user/assistant text messages");
    expect(logs).toContain("slack  returns a recipe");
  });

  it("rejects multiple --source flags", async () => {
    await expect(
      zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "logs",
        "--source",
        "chat",
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain("Only one --source is allowed.");
  });

  it("rejects an unknown --source value", async () => {
    await expect(
      zeroSearchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "nope",
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain('Unknown --source "nope"');
    expect(errors).toContain("logs, chat, slack");
  });

  it("routes --source logs to the logs-search backend", async () => {
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    let called = false;
    server.use(
      http.get("http://localhost:3000/api/zero/logs/search", () => {
        called = true;
        return HttpResponse.json({ results: [], hasMore: false });
      }),
    );

    await zeroSearchCommand.parseAsync([
      "node",
      "cli",
      "hello",
      "--source",
      "logs",
    ]);

    expect(called).toBe(true);
  });

  it("--help output includes the three source descriptions", () => {
    let captured = "";
    zeroSearchCommand.configureOutput({
      writeOut: (s) => {
        captured += s;
      },
      writeErr: (s) => {
        captured += s;
      },
    });
    zeroSearchCommand.outputHelp();
    expect(captured).toContain("logs   full agent event stream");
    expect(captured).toContain("chat   user/assistant text messages");
    expect(captured).toContain("slack  returns a recipe");
  });

  it("SEARCH_EXPLAINER is the single source of truth for source descriptions", () => {
    expect(SEARCH_EXPLAINER).toContain("logs   full agent event stream");
    expect(SEARCH_EXPLAINER).toContain("chat   user/assistant text messages");
    expect(SEARCH_EXPLAINER).toContain("slack  returns a recipe");
  });
});
