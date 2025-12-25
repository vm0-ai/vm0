/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mock functions so they're available during module initialization
const { mockInfo, mockWarn, mockError, mockDebug, mockFlush, mockWithAxiom } =
  vi.hoisted(() => ({
    mockInfo: vi.fn(),
    mockWarn: vi.fn(),
    mockError: vi.fn(),
    mockDebug: vi.fn(),
    mockFlush: vi.fn().mockResolvedValue(undefined),
    mockWithAxiom: vi.fn((handler: unknown) => handler),
  }));

// Mock @axiomhq/logging
vi.mock("@axiomhq/logging", () => ({
  Logger: vi.fn().mockImplementation(() => ({
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
    debug: mockDebug,
    flush: mockFlush,
    log: vi.fn(),
    with: vi.fn(),
    raw: vi.fn(),
  })),
  AxiomJSTransport: vi.fn(),
  ConsoleTransport: vi.fn(),
}));

// Mock @axiomhq/nextjs
vi.mock("@axiomhq/nextjs", () => ({
  createAxiomRouteHandler: vi.fn(() => mockWithAxiom),
  nextJsFormatters: [],
}));

// Mock @axiomhq/js
vi.mock("@axiomhq/js", () => ({
  Axiom: vi.fn(),
}));

// Mock datasets
vi.mock("../datasets", () => ({
  getDatasetName: vi.fn().mockReturnValue("vm0-web-logs-dev"),
  DATASETS: {
    WEB_LOGS: "web-logs",
  },
}));

// Import after mocks
import { getLogger, withAxiom, resetAxiomLogger } from "../server";

describe("axiom/server", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
    resetAxiomLogger();
  });

  describe("getLogger", () => {
    it("should return a logger when AXIOM_TOKEN is configured", () => {
      process.env.AXIOM_TOKEN = "test-token";
      resetAxiomLogger();

      const logger = getLogger();
      logger.info("test message");

      expect(mockInfo).toHaveBeenCalledWith("test message");
    });

    it("should return no-op logger when AXIOM_TOKEN is not configured", () => {
      delete process.env.AXIOM_TOKEN;
      resetAxiomLogger();

      const logger = getLogger();

      // Should not throw
      expect(() => {
        logger.info("test");
        logger.warn("test");
        logger.error("test");
        logger.debug("test");
      }).not.toThrow();
    });

    it("should return cached logger on subsequent calls", () => {
      process.env.AXIOM_TOKEN = "test-token";
      resetAxiomLogger();

      const logger1 = getLogger();
      const logger2 = getLogger();

      expect(logger1).toBe(logger2);
    });
  });

  describe("withAxiom", () => {
    it("should be a function", () => {
      expect(typeof withAxiom).toBe("function");
    });

    it("should wrap route handlers", async () => {
      const handler = vi.fn().mockResolvedValue(new Response("ok"));
      const wrapped = withAxiom(handler);

      const req = new Request("http://localhost/api/test");
      await wrapped(req, {});

      expect(handler).toHaveBeenCalledWith(req, {});
    });
  });

  describe("resetAxiomLogger", () => {
    it("should reset the logger singleton", () => {
      process.env.AXIOM_TOKEN = "test-token";

      const logger1 = getLogger();
      resetAxiomLogger();
      const logger2 = getLogger();

      // After reset, getLogger should create a new instance
      // Note: Both will be mock instances, but resetAxiomLogger clears internal state
      expect(logger1).not.toBe(logger2);
    });
  });
});
