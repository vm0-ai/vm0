import { describe, it, expect, vi, beforeEach } from "vitest";
import { EVENT } from "@axiomhq/logging";
import { flushLogs, logger, __resetForTest } from "../log";
import { testContext } from "../../__tests__/test-helpers";

const { axiomLogging } = testContext().mocks;

beforeEach(() => {
  __resetForTest();
  axiomLogging.flush.mockResolvedValue(undefined);
});

// ── logToAxiom dispatches to correct @axiomhq/logging level ─────────────────

describe("logToAxiom level dispatch", () => {
  it("dispatches debug to alog.debug with source: api", () => {
    const log = logger("test-debug");
    log.debug("hello", { key: "value" });

    expect(axiomLogging.debug).toHaveBeenCalledWith("hello", {
      key: "value",
      context: "test-debug",
      [EVENT]: { source: "api" },
    });
  });

  it("dispatches info to alog.info with source: api", () => {
    const log = logger("test-info");
    log.info("info msg");

    expect(axiomLogging.info).toHaveBeenCalledWith("info msg", {
      context: "test-info",
      [EVENT]: { source: "api" },
    });
  });

  it("dispatches warn to alog.warn with source: api", () => {
    const log = logger("test-warn");
    log.warn("warning");

    expect(axiomLogging.warn).toHaveBeenCalledWith("warning", {
      context: "test-warn",
      [EVENT]: { source: "api" },
    });
  });

  it("dispatches error to alog.error with source: api", () => {
    const log = logger("test-err");
    log.error("boom");

    expect(axiomLogging.error).toHaveBeenCalledWith("boom", {
      context: "test-err",
      [EVENT]: { source: "api" },
    });
  });

  it("dispatches fatal to alog.error with source: api", () => {
    const log = logger("test-fatal");
    log.fatal("dead");

    expect(axiomLogging.error).toHaveBeenCalledWith("dead", {
      context: "test-fatal",
      [EVENT]: { source: "api" },
    });
  });

  it("converts non-string first arg to string for the Axiom message", () => {
    const log = logger("test-obj");
    const obj = { nested: true };
    log.info(obj);

    expect(axiomLogging.info).toHaveBeenCalledWith(
      String(obj),
      expect.objectContaining({ [EVENT]: { source: "api" } }),
    );
  });
});

// ── Axiom log calls include [EVENT]: { source: "api" } ───────────────────────────────────

describe("Axiom log source field", () => {
  it("includes source: api in info logs", () => {
    const log = logger("source-test");
    log.info("msg");

    expect(axiomLogging.info).toHaveBeenCalledWith(
      "msg",
      expect.objectContaining({ [EVENT]: { source: "api" } }),
    );
  });

  it("includes source: api in error logs with Error objects", () => {
    const log = logger("source-err");
    const err = new Error("fail");
    log.error(err);

    expect(axiomLogging.error).toHaveBeenCalledWith(
      "fail",
      expect.objectContaining({ [EVENT]: { source: "api" } }),
    );
  });

  it("places context before spread fields so user fields don't overwrite context", () => {
    const log = logger("ctx-test");
    log.warn("msg", { context: "evil" });

    // context should be from the logger name, not from user fields
    expect(axiomLogging.warn).toHaveBeenCalledWith("msg", {
      context: "ctx-test",
      [EVENT]: { source: "api" },
    });
  });
});

// ── flushLogs ───────────────────────────────────────────────────────────────

describe("flushLogs", () => {
  it("calls alog.flush()", async () => {
    // Trigger axiom logger creation by logging
    logger("flush-test").info("msg");
    await flushLogs();

    expect(axiomLogging.flush).toHaveBeenCalledOnce();
  });

  it("does not throw when flush fails", async () => {
    axiomLogging.flush.mockRejectedValueOnce(new Error("flush down"));
    logger("fail-flush").info("msg");

    await expect(flushLogs()).resolves.toBeUndefined();
  });

  it("does not throw when axiom is not initialized", async () => {
    // Reset so singleton re-evaluates — but env token is already set
    __resetForTest();
    // flushLogs calls getAxiomLogger()?.flush() — optional chain handles null
    await expect(flushLogs()).resolves.toBeUndefined();
  });
});

// ── serializeError (via extractFields + Error in log) ───────────────────────

describe("serializeError via logging", () => {
  it("includes non-enumerable Error properties in Axiom fields", () => {
    const log = logger("serialize");
    const err = new Error("test error");
    log.error(err);

    expect(axiomLogging.error).toHaveBeenCalledWith(
      "test error",
      expect.objectContaining({
        error: expect.objectContaining({
          name: "Error",
          message: "test error",
          stack: expect.any(String),
        }),
        [EVENT]: { source: "api" },
      }),
    );
  });

  it("recursively serializes error.cause", () => {
    const log = logger("cause-test");
    const cause = new Error("root cause");
    const err = new Error("wrapped", { cause });
    log.error(err);

    expect(axiomLogging.error).toHaveBeenCalledWith(
      "wrapped",
      expect.objectContaining({
        error: expect.objectContaining({
          message: "wrapped",
          cause: expect.objectContaining({
            name: "Error",
            message: "root cause",
          }),
        }),
      }),
    );
  });

  it("surfaces custom enumerable properties on Error", () => {
    const log = logger("custom-err");
    const err = new Error("custom") as Error & Record<string, unknown>;
    err.code = "ERR_TEST";
    err.statusCode = 500;
    log.error(err);

    const fields = axiomLogging.error.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(fields?.error).toMatchObject({
      name: "Error",
      message: "custom",
      code: "ERR_TEST",
      statusCode: 500,
    });
  });
});

// ── extractFields via logging ───────────────────────────────────────────────

describe("extractFields via logging", () => {
  it("wraps Error second argument under { error: ... }", () => {
    const log = logger("extract-err");
    const err = new Error("boom");
    log.info("oh no", err);

    expect(axiomLogging.info).toHaveBeenCalledWith(
      "oh no",
      expect.objectContaining({
        error: expect.objectContaining({
          message: "boom",
        }),
      }),
    );
  });

  it("passes plain object second argument directly as fields", () => {
    const log = logger("extract-obj");
    log.info("data", { count: 42 });

    expect(axiomLogging.info).toHaveBeenCalledWith("data", {
      count: 42,
      context: "extract-obj",
      [EVENT]: { source: "api" },
    });
  });

  it("wraps multiple extra args in { args: [...] }", () => {
    const log = logger("extract-multi");
    log.info("msg", 1, "two", { three: 3 });

    expect(axiomLogging.info).toHaveBeenCalledWith(
      "msg",
      expect.objectContaining({
        args: [1, "two", { three: 3 }],
      }),
    );
  });
});

// ── getAxiomLogger returns null when token is unset ────────────────────────

describe("getAxiomLogger with no token", () => {
  it("returns null when AXIOM_TOKEN_TELEMETRY is unset", async () => {
    vi.resetModules();

    // Mock env to return empty string for AXIOM_TOKEN_TELEMETRY so
    // getAxiomLogger returns null. We mock the entire env module
    // because the real module calls createEnv which requires
    // AXIOM_TOKEN_TELEMETRY to be a non-empty string.
    // eslint-disable-next-line api/no-test-vi-mocks
    vi.doMock("../env", () => {
      return {
        env: (name: string) => {
          if (name === "AXIOM_TOKEN_TELEMETRY") {
            return "";
          }
          if (name === "AXIOM_DATASET_SUFFIX") {
            return "dev";
          }
          return "";
        },
        mockEnv: () => {},
        clearMockedEnv: () => {},
      };
    });

    const mod = await import("../log");
    const log = mod.logger("no-token-test");
    log.info("should not reach axiom");

    // Axiom mock methods should not have been called
    // oxlint-disable-next-line vitest/prefer-called-with
    expect(axiomLogging.info).not.toHaveBeenCalled();

    vi.resetModules();
  });
});

// ── Logger caching and basic behavior ───────────────────────────────────────

describe("logger", () => {
  it("caches logger instances by name", () => {
    expect(logger("Cache")).toBe(logger("Cache"));
  });

  it("creates distinct loggers for different names", () => {
    expect(logger("A")).not.toBe(logger("B"));
  });

  it("emits to console in addition to Axiom (dual-write)", () => {
    // eslint-disable-next-line api/no-test-vi-mocks
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    // eslint-disable-next-line api/no-test-vi-mocks
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    // eslint-disable-next-line no-restricted-syntax
    try {
      const log = logger("dual");
      log.info("dual msg");
      log.error("dual error");

      expect(consoleLog).toHaveBeenCalledWith(expect.any(String));
      expect(consoleError).toHaveBeenCalledWith(expect.any(String));
    } finally {
      consoleLog.mockRestore();
      consoleError.mockRestore();
    }
  });
});
