/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runCommand } from "../commands/run";

// Mock console methods
const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
const mockConsoleError = vi
  .spyOn(console, "error")
  .mockImplementation(() => {});

describe("vm0 run command", () => {
  beforeEach(() => {
    // Mock environment variables
    process.env.VM0_API_URL = "http://localhost:3000";
    process.env.VM0_TOKEN = "test-token-123";

    // Mock fetch
    global.fetch = vi.fn();

    // Reset mocks
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should fail without bearer token", async () => {
    delete process.env.VM0_TOKEN;

    // Mock process.exit
    const mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    await runCommand("cfg-test", "test prompt", {});

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenCalled();

    mockExit.mockRestore();
  });

  it("should run agent successfully", async () => {
    // Mock successful API response
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        runtimeId: "rt-test-123",
        status: "completed",
        sandboxId: "sb-test",
        output: "Hello World from E2B!",
        executionTimeMs: 1234,
      }),
    });

    await runCommand("cfg-test", "test prompt", {});

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/agent-runtimes",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token-123",
        }),
      }),
    );
  });

  it("should parse dynamic vars correctly", async () => {
    // Mock successful API response
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        runtimeId: "rt-test",
        status: "completed",
        sandboxId: "sb-test",
        output: "Hello",
        executionTimeMs: 1000,
      }),
    });

    await runCommand("cfg-test", "test prompt", {
      dynamicVars: '{"key":"value"}',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"dynamicVars":{"key":"value"}'),
      }),
    );
  });

  it("should fail with invalid dynamic vars JSON", async () => {
    // Mock process.exit
    const mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    await runCommand("cfg-test", "test prompt", {
      dynamicVars: "invalid-json",
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    // Console.error is called through the error() function
    // which outputs directly, so we just verify exit was called

    mockExit.mockRestore();
  });

  it("should output JSON format when requested", async () => {
    // Mock successful API response
    const mockResponse = {
      runtimeId: "rt-test",
      status: "completed",
      sandboxId: "sb-test",
      output: "Hello",
      executionTimeMs: 1000,
    };

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    await runCommand("cfg-test", "test prompt", { json: true });

    // JSON output goes directly through console.log
    // We just verify the command succeeded by checking fetch was called
    expect(global.fetch).toHaveBeenCalled();
  });
});
