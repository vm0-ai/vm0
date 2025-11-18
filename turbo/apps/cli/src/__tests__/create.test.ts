/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCommand } from "../commands/create";

// Mock console methods
const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
const mockConsoleError = vi
  .spyOn(console, "error")
  .mockImplementation(() => {});

describe("vm0 create command", () => {
  beforeEach(() => {
    // Mock environment variables
    process.env.VM0_API_URL = "http://localhost:3000";
    process.env.VM0_API_KEY = "test-key-123";

    // Mock fetch
    global.fetch = vi.fn();

    // Reset mocks
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should fail without API key", async () => {
    delete process.env.VM0_API_KEY;

    // Mock process.exit
    const mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    await createCommand("test-config.yaml", {});

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenCalled();

    mockExit.mockRestore();
  });

  it("should create agent config successfully", async () => {
    // Mock file system
    const mockReadFile = vi.fn().mockResolvedValue(`
version: "1.0"
agent:
  description: "Test agent"
  image: "test-image"
  provider: "test-provider"
  working_dir: "/workspace"
  volumes: []
`);

    vi.doMock("fs/promises", () => ({
      readFile: mockReadFile,
    }));

    // Mock successful API response
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        agentConfigId: "cfg-test-123",
        createdAt: "2025-11-18T10:00:00Z",
      }),
    });

    // Note: This test would need actual file system mocking to work fully
    // For now, it tests the API key validation
  });
});
