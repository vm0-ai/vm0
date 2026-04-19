import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture calls made into the Axiom logger transport so we can assert how
// arguments are serialized by extractFields().
const mockDebug = vi.fn();
const mockInfo = vi.fn();
const mockWarn = vi.fn();
const mockError = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(undefined);

vi.mock("@axiomhq/js", () => {
  return {
    Axiom: vi.fn().mockImplementation(function () {
      return {
        query: vi.fn(),
        ingest: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

vi.mock("@axiomhq/logging", () => {
  return {
    Logger: vi.fn().mockImplementation(function () {
      return {
        debug: mockDebug,
        info: mockInfo,
        warn: mockWarn,
        error: mockError,
        flush: mockFlush,
      };
    }),
    AxiomJSTransport: vi.fn().mockImplementation(function () {
      return {};
    }),
  };
});

beforeEach(() => {
  vi.stubEnv("AXIOM_TOKEN_TELEMETRY", "test-token");
  vi.stubEnv("VM0_DEBUG", "*");
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("logger extractFields", () => {
  it("serializes Error instances into fields.error (not empty object)", async () => {
    const { logger } = await import("../logger");
    const log = logger("test:error-serialization");

    const err = new Error("boom");
    err.stack = "Error: boom\n    at test.ts:1:1";
    log.error("operation failed:", err);

    expect(mockError).toHaveBeenCalledTimes(1);
    const [message, fields] = mockError.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(message).toBe("operation failed:");
    expect(fields.context).toBe("test:error-serialization");
    expect(fields.error).toMatchObject({
      name: "Error",
      message: "boom",
      stack: "Error: boom\n    at test.ts:1:1",
    });
  });

  it("preserves enumerable own properties on custom errors (e.g. code)", async () => {
    const { logger } = await import("../logger");
    const log = logger("test:custom-error");

    const err = new Error("db failed") as Error & {
      code?: string;
      statusCode?: number;
    };
    err.code = "ECONNREFUSED";
    err.statusCode = 503;
    log.error("db:", err);

    const [, fields] = mockError.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(fields.error).toMatchObject({
      name: "Error",
      message: "db failed",
      code: "ECONNREFUSED",
      statusCode: 503,
    });
  });

  it("serializes Error cause recursively", async () => {
    const { logger } = await import("../logger");
    const log = logger("test:cause");

    const root = new Error("root cause");
    const wrapped = new Error("wrapped", { cause: root });
    log.error("wrapped:", wrapped);

    const [, fields] = mockError.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const error = fields.error as Record<string, unknown>;
    expect(error.message).toBe("wrapped");
    expect(error.cause).toMatchObject({
      name: "Error",
      message: "root cause",
    });
  });

  it("still treats plain objects as fields (unchanged behavior)", async () => {
    const { logger } = await import("../logger");
    const log = logger("test:plain-object");

    log.info("user logged in", { userId: "u-123", orgId: "o-456" });

    const [message, fields] = mockInfo.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(message).toBe("user logged in");
    expect(fields).toMatchObject({
      context: "test:plain-object",
      userId: "u-123",
      orgId: "o-456",
    });
    expect(fields.error).toBeUndefined();
  });
});
