import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  logger,
  Level,
  setLogErrorHandler,
  resetLoggerForTest,
} from "../log.ts";

describe("setLogErrorHandler", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetLoggerForTest();
    // The global setup overrides console.error to throw on unexpected calls.
    // This test suite intentionally triggers console.error via the log module,
    // so we suppress it here.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("should invoke handler on error()", () => {
    const handler = vi.fn();
    setLogErrorHandler(handler);

    const log = logger("test-error");
    log.error("something went wrong");

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("test-error", [
      "something went wrong",
    ]);
  });

  it("should invoke handler on fatal()", () => {
    const handler = vi.fn();
    setLogErrorHandler(handler);

    const log = logger("test-fatal");
    log.fatal("critical failure");

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("test-fatal", ["critical failure"]);
  });

  it("should invoke handler with Error objects", () => {
    const handler = vi.fn();
    setLogErrorHandler(handler);

    const err = new Error("boom");
    const log = logger("test-err-obj");
    log.error(err);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("test-err-obj", [err]);
  });

  it("should invoke handler with multiple args", () => {
    const handler = vi.fn();
    setLogErrorHandler(handler);

    const err = new Error("boom");
    const log = logger("test-multi");
    log.error("context", err, 42);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("test-multi", ["context", err, 42]);
  });

  it("should not invoke handler for debug level", () => {
    const handler = vi.fn();
    setLogErrorHandler(handler);

    const log = logger("test-debug");
    log.level = Level.Debug;
    log.debug("debug message");

    expect(handler).not.toHaveBeenCalled();
  });

  it("should not invoke handler for info level", () => {
    const handler = vi.fn();
    setLogErrorHandler(handler);

    const log = logger("test-info");
    log.info("info message");

    expect(handler).not.toHaveBeenCalled();
  });

  it("should not invoke handler for warn level", () => {
    const handler = vi.fn();
    setLogErrorHandler(handler);

    const log = logger("test-warn");
    log.warn("warn message");

    expect(handler).not.toHaveBeenCalled();
  });

  it("should not invoke handler for trace level", () => {
    const handler = vi.fn();
    setLogErrorHandler(handler);

    const log = logger("test-trace");
    log.level = Level.Debug;
    log.trace("trace message");

    expect(handler).not.toHaveBeenCalled();
  });

  it("should not throw when no handler is set", () => {
    const log = logger("test-no-handler");
    expect(() => {
      return log.error("no handler");
    }).not.toThrow();
  });

  it("should pass a copy of args to the handler", () => {
    const handler = vi.fn();
    setLogErrorHandler(handler);

    const log = logger("test-copy");
    log.error("msg");

    const passedArgs = handler.mock.calls[0]![1] as unknown[];
    expect(passedArgs).toStrictEqual(["msg"]);
  });

  it("should clear handler on resetLoggerForTest", () => {
    const handler = vi.fn();
    setLogErrorHandler(handler);

    resetLoggerForTest();

    const log = logger("test-reset");
    log.error("after reset");

    expect(handler).not.toHaveBeenCalled();
  });
});
