import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @axiomhq/logging
const mockDebug = vi.fn();
const mockInfo = vi.fn();
const mockWarn = vi.fn();
const mockError = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(undefined);

vi.mock("@axiomhq/logging", () => ({
  Logger: vi.fn().mockImplementation(() => ({
    debug: mockDebug,
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
    flush: mockFlush,
  })),
  AxiomJSTransport: vi.fn(),
}));

// Mock @axiomhq/js
vi.mock("@axiomhq/js", () => ({
  Axiom: vi.fn(),
}));

// Import after mocks
import { logger, clearLoggerCache, flushLogs } from "../logger";

describe("logger", () => {
  const consoleSpy = {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };

  beforeEach(() => {
    // Clear all mocks
    vi.clearAllMocks();
    clearLoggerCache();
  });

  afterEach(() => {
    // Only restore individual env vars that were stubbed in this file
    // Don't use vi.unstubAllEnvs() as it clears stubs from setup.ts
    vi.stubEnv("DEBUG", "");
    vi.stubEnv("NODE_ENV", "test");
  });

  describe("console output", () => {
    it("should output info logs to console", () => {
      const log = logger("test");
      log.info("hello world");

      expect(consoleSpy.info).toHaveBeenCalledWith("[INFO] [test] hello world");
    });

    it("should output warn logs to console", () => {
      const log = logger("test");
      log.warn("warning message");

      expect(consoleSpy.warn).toHaveBeenCalledWith(
        "[WARN] [test] warning message",
      );
    });

    it("should output error logs to console", () => {
      const log = logger("test");
      log.error("error message");

      expect(consoleSpy.error).toHaveBeenCalledWith(
        "[ERROR] [test] error message",
      );
    });

    it("should include additional arguments in console output", () => {
      const log = logger("test");
      const data = { id: "123" };
      log.info("created", data);

      expect(consoleSpy.info).toHaveBeenCalledWith(
        "[INFO] [test] created",
        data,
      );
    });
  });

  describe("DEBUG filtering", () => {
    it("should not output debug logs when DEBUG is not set", () => {
      const log = logger("test");
      log.debug("debug message");

      expect(consoleSpy.log).not.toHaveBeenCalled();
    });

    it("should output debug logs when DEBUG matches logger name", () => {
      vi.stubEnv("DEBUG", "test");
      clearLoggerCache();

      const log = logger("test");
      log.debug("debug message");

      expect(consoleSpy.log).toHaveBeenCalledWith(
        "[DEBUG] [test] debug message",
      );
    });

    it("should output debug logs when DEBUG is wildcard (*)", () => {
      vi.stubEnv("DEBUG", "*");
      clearLoggerCache();

      const log = logger("test");
      log.debug("debug message");

      expect(consoleSpy.log).toHaveBeenCalledWith(
        "[DEBUG] [test] debug message",
      );
    });

    it("should output debug logs when DEBUG matches prefix wildcard", () => {
      vi.stubEnv("DEBUG", "service:*");
      clearLoggerCache();

      const log = logger("service:e2b");
      log.debug("debug message");

      expect(consoleSpy.log).toHaveBeenCalledWith(
        "[DEBUG] [service:e2b] debug message",
      );
    });

    it("should not output debug logs when DEBUG does not match", () => {
      vi.stubEnv("DEBUG", "other");
      clearLoggerCache();

      const log = logger("test");
      log.debug("debug message");

      expect(consoleSpy.log).not.toHaveBeenCalled();
    });

    it("should auto-enable debug in development mode", () => {
      vi.stubEnv("NODE_ENV", "development");
      clearLoggerCache();

      const log = logger("test");
      log.debug("debug message");

      expect(consoleSpy.log).toHaveBeenCalledWith(
        "[DEBUG] [test] debug message",
      );
    });
  });

  describe("Axiom integration", () => {
    beforeEach(() => {
      vi.stubEnv("AXIOM_TOKEN", "test-token");
      clearLoggerCache();
    });

    it("should send info logs to Axiom when configured", () => {
      const log = logger("test");
      log.info("hello world");

      expect(mockInfo).toHaveBeenCalledWith("hello world", { context: "test" });
    });

    it("should send warn logs to Axiom when configured", () => {
      const log = logger("test");
      log.warn("warning");

      expect(mockWarn).toHaveBeenCalledWith("warning", { context: "test" });
    });

    it("should send error logs to Axiom when configured", () => {
      const log = logger("test");
      log.error("error");

      expect(mockError).toHaveBeenCalledWith("error", { context: "test" });
    });

    it("should send debug logs to Axiom when DEBUG is enabled", () => {
      vi.stubEnv("DEBUG", "*");
      clearLoggerCache();

      const log = logger("test");
      log.debug("debug");

      expect(mockDebug).toHaveBeenCalledWith("debug", { context: "test" });
    });

    it("should include structured fields in Axiom logs", () => {
      const log = logger("test");
      const fields = { userId: "123", action: "create" };
      log.info("user action", fields);

      expect(mockInfo).toHaveBeenCalledWith("user action", {
        context: "test",
        userId: "123",
        action: "create",
      });
    });

    it("should wrap multiple arguments in args field", () => {
      const log = logger("test");
      log.info("multiple", "arg1", "arg2");

      expect(mockInfo).toHaveBeenCalledWith("multiple", {
        context: "test",
        args: ["arg1", "arg2"],
      });
    });
  });

  describe("Axiom not configured", () => {
    it("should not send to Axiom when AXIOM_TOKEN is not set", () => {
      // Clear AXIOM_TOKEN to simulate unconfigured state
      vi.stubEnv("AXIOM_TOKEN", "");
      clearLoggerCache();

      const log = logger("test");
      log.info("hello");

      // Console should still work
      expect(consoleSpy.info).toHaveBeenCalled();
      // But Axiom should not be called
      expect(mockInfo).not.toHaveBeenCalled();
    });
  });

  describe("logger caching", () => {
    it("should return cached logger for same name", () => {
      const log1 = logger("test");
      const log2 = logger("test");

      expect(log1).toBe(log2);
    });

    it("should return different loggers for different names", () => {
      const log1 = logger("test1");
      const log2 = logger("test2");

      expect(log1).not.toBe(log2);
    });

    it("should create new logger after cache is cleared", () => {
      const log1 = logger("test");
      clearLoggerCache();
      const log2 = logger("test");

      expect(log1).not.toBe(log2);
    });
  });

  describe("formatMessage helper", () => {
    it("should handle empty args", () => {
      vi.stubEnv("AXIOM_TOKEN", "test-token");
      clearLoggerCache();

      const log = logger("test");
      log.info();

      expect(mockInfo).toHaveBeenCalledWith("", { context: "test" });
    });

    it("should convert non-string first arg to string", () => {
      vi.stubEnv("AXIOM_TOKEN", "test-token");
      clearLoggerCache();

      const log = logger("test");
      log.info(123);

      expect(mockInfo).toHaveBeenCalledWith("123", { context: "test" });
    });
  });

  describe("flushLogs", () => {
    it("should call flush on Axiom logger when configured", async () => {
      vi.stubEnv("AXIOM_TOKEN", "test-token");
      clearLoggerCache();

      // Trigger logger initialization
      const log = logger("test");
      log.info("trigger init");

      await flushLogs();

      expect(mockFlush).toHaveBeenCalled();
    });

    it("should not throw when Axiom is not configured", async () => {
      // Clear AXIOM_TOKEN to simulate unconfigured state
      vi.stubEnv("AXIOM_TOKEN", "");
      clearLoggerCache();

      // Should not throw
      await expect(flushLogs()).resolves.toBeUndefined();
    });
  });
});
