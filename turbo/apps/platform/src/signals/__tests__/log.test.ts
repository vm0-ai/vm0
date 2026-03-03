import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  logger,
  Level,
  setLogErrorHandler,
  resetLoggerForTest,
} from "../log.ts";

describe("setLogErrorHandler", () => {
  beforeEach(() => {
    resetLoggerForTest();
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
    expect(() => log.error("no handler")).not.toThrow();
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
