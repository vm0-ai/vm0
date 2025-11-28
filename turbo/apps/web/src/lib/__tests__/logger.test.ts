import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger, clearLoggerCache } from "../logger";

// Helper to set NODE_ENV (readonly in TypeScript)
const setNodeEnv = (value: string) => {
  (process.env as Record<string, string>).NODE_ENV = value;
};

describe("logger", () => {
  const originalDebug = process.env.DEBUG;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    clearLoggerCache();
    // Reset to production-like environment for consistent tests
    delete process.env.DEBUG;
    setNodeEnv("production");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.DEBUG = originalDebug;
    if (originalNodeEnv) setNodeEnv(originalNodeEnv);
    vi.restoreAllMocks();
  });

  describe("logger creation", () => {
    it("creates a logger with the given name", () => {
      const log = logger("test:module");
      expect(log).toBeDefined();
      expect(log.debug).toBeTypeOf("function");
      expect(log.info).toBeTypeOf("function");
      expect(log.warn).toBeTypeOf("function");
      expect(log.error).toBeTypeOf("function");
    });

    it("returns cached logger for same name", () => {
      const log1 = logger("test:module");
      const log2 = logger("test:module");
      expect(log1).toBe(log2);
    });

    it("returns different logger for different name", () => {
      const log1 = logger("test:module1");
      const log2 = logger("test:module2");
      expect(log1).not.toBe(log2);
    });
  });

  describe("output format", () => {
    it("formats output as [LEVEL] [name] message", () => {
      process.env.DEBUG = "*";
      clearLoggerCache();
      const log = logger("service:e2b");

      log.debug("test message");
      expect(console.log).toHaveBeenCalledWith(
        "[DEBUG] [service:e2b] test message",
      );

      log.warn("warning message");
      expect(console.warn).toHaveBeenCalledWith(
        "[WARN] [service:e2b] warning message",
      );

      log.error("error message");
      expect(console.error).toHaveBeenCalledWith(
        "[ERROR] [service:e2b] error message",
      );
    });

    it("handles multiple arguments", () => {
      process.env.DEBUG = "*";
      clearLoggerCache();
      const log = logger("service:e2b");

      log.debug("message", { id: "123" });
      expect(console.log).toHaveBeenCalledWith(
        "[DEBUG] [service:e2b] message",
        { id: "123" },
      );
    });

    it("handles non-string first argument", () => {
      process.env.DEBUG = "*";
      clearLoggerCache();
      const log = logger("service:e2b");

      log.debug({ id: "123" });
      expect(console.log).toHaveBeenCalledWith("[DEBUG] [service:e2b]", {
        id: "123",
      });
    });

    it("handles no arguments", () => {
      process.env.DEBUG = "*";
      clearLoggerCache();
      const log = logger("service:e2b");

      log.debug();
      expect(console.log).toHaveBeenCalledWith("[DEBUG] [service:e2b]");
    });
  });

  describe("DEBUG environment variable", () => {
    it("suppresses debug when DEBUG is not set", () => {
      delete process.env.DEBUG;
      clearLoggerCache();
      const log = logger("service:e2b");

      log.debug("should not appear");
      expect(console.log).not.toHaveBeenCalled();
    });

    it("enables debug when DEBUG matches exactly", () => {
      process.env.DEBUG = "service:e2b";
      clearLoggerCache();
      const log = logger("service:e2b");

      log.debug("should appear");
      expect(console.log).toHaveBeenCalled();
    });

    it("enables debug when DEBUG=*", () => {
      process.env.DEBUG = "*";
      clearLoggerCache();
      const log = logger("service:e2b");

      log.debug("should appear");
      expect(console.log).toHaveBeenCalled();
    });

    it("enables debug with wildcard prefix match", () => {
      process.env.DEBUG = "service:*";
      clearLoggerCache();
      const log = logger("service:e2b");

      log.debug("should appear");
      expect(console.log).toHaveBeenCalled();
    });

    it("does not match different prefix with wildcard", () => {
      process.env.DEBUG = "api:*";
      clearLoggerCache();
      const log = logger("service:e2b");

      log.debug("should not appear");
      expect(console.log).not.toHaveBeenCalled();
    });

    it("supports multiple patterns separated by comma", () => {
      process.env.DEBUG = "api:runs,service:e2b";
      clearLoggerCache();

      const log1 = logger("service:e2b");
      const log2 = logger("api:runs");
      const log3 = logger("service:other");

      log1.debug("should appear");
      log2.debug("should appear");
      log3.debug("should not appear");

      expect(console.log).toHaveBeenCalledTimes(2);
    });
  });

  describe("warn and error always output", () => {
    it("outputs warn regardless of DEBUG", () => {
      delete process.env.DEBUG;
      clearLoggerCache();
      const log = logger("service:e2b");

      log.warn("warning");
      expect(console.warn).toHaveBeenCalledWith("[WARN] [service:e2b] warning");
    });

    it("outputs error regardless of DEBUG", () => {
      delete process.env.DEBUG;
      clearLoggerCache();
      const log = logger("service:e2b");

      log.error("error");
      expect(console.error).toHaveBeenCalledWith("[ERROR] [service:e2b] error");
    });
  });

  describe("info level", () => {
    it("outputs info regardless of DEBUG", () => {
      delete process.env.DEBUG;
      clearLoggerCache();
      const log = logger("service:e2b");

      log.info("info message");
      expect(console.info).toHaveBeenCalledWith(
        "[INFO] [service:e2b] info message",
      );
    });
  });

  describe("auto-enable debug", () => {
    it("auto-enables debug in development environment", () => {
      delete process.env.DEBUG;
      setNodeEnv("development");
      clearLoggerCache();
      const log = logger("service:e2b");

      log.debug("should appear in dev");
      expect(console.log).toHaveBeenCalled();
    });

    it("does not auto-enable debug in production", () => {
      delete process.env.DEBUG;
      setNodeEnv("production");
      clearLoggerCache();
      const log = logger("service:e2b");

      log.debug("should not appear in production");
      expect(console.log).not.toHaveBeenCalled();
    });

    it("explicit DEBUG overrides auto-enable", () => {
      process.env.DEBUG = "other:logger";
      setNodeEnv("development");
      clearLoggerCache();
      const log = logger("service:e2b");

      log.debug("should not appear - explicit DEBUG set");
      expect(console.log).not.toHaveBeenCalled();
    });
  });
});
