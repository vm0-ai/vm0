/**
 * Integration tests for the logger's Error serialization path.
 *
 * These tests verify that Error objects passed to log.error() are correctly
 * serialized into a structured Axiom payload (including non-enumerable built-in
 * properties like name, message, and stack) rather than arriving as empty objects.
 *
 * We use vi.resetModules() + dynamic imports so that each test suite gets a
 * fresh logger module — necessary because the logger keeps an axiomInitialized
 * singleton that would otherwise prevent Axiom from being set up after the
 * token is stubbed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

describe("logger Error serialization → Axiom payload", () => {
  let mockLoggerError: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Stub token before module load so getAxiomLogger() finds a valid token.
    vi.stubEnv("AXIOM_TOKEN_TELEMETRY", "test-token");

    // Reset modules so the logger and axiom singletons are re-created.
    vi.resetModules();

    mockLoggerError = vi.fn();

    // Mock @axiomhq/js so that getTelemetryInstance() returns a non-null client
    // (the logger only creates the AxiomLogger when this returns truthy).
    vi.doMock("@axiomhq/js", () => {
      return {
        Axiom: vi.fn().mockImplementation(function () {
          return { query: vi.fn(), ingest: vi.fn(), flush: vi.fn() };
        }),
      };
    });

    // Mock @axiomhq/logging to capture what is sent to Axiom.
    vi.doMock("@axiomhq/logging", () => {
      return {
        Logger: vi.fn().mockImplementation(function () {
          return {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: mockLoggerError,
            flush: vi.fn().mockResolvedValue(undefined),
          };
        }),
        AxiomJSTransport: vi.fn().mockImplementation(function () {
          return {};
        }),
      };
    });
  });

  it("should send non-enumerable Error properties (name, message, stack) to Axiom", async () => {
    const { logger } = await import("../logger");
    const log = logger("test:serialization");

    const err = new Error("connection reset");
    log.error("operation failed", err);

    expect(mockLoggerError).toHaveBeenCalledOnce();
    const [, fields] = mockLoggerError.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(fields).toHaveProperty("error");
    const serialized = fields["error"] as Record<string, unknown>;
    expect(serialized.name).toBe("Error");
    expect(serialized.message).toBe("connection reset");
    expect(typeof serialized.stack).toBe("string");
    expect(serialized.stack).toContain("connection reset");
  });

  it("should include enumerable custom properties on Error in Axiom payload", async () => {
    const { logger } = await import("../logger");
    const log = logger("test:serialization");

    const err = Object.assign(new Error("not found"), { statusCode: 404 });
    log.error("operation failed", err);

    const [, fields] = mockLoggerError.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const serialized = fields["error"] as Record<string, unknown>;
    expect(serialized.statusCode).toBe(404);
  });

  it("should recursively serialize a nested Error cause in Axiom payload", async () => {
    const { logger } = await import("../logger");
    const log = logger("test:serialization");

    const cause = new Error("original cause");
    const err = new Error("wrapper error", { cause });
    log.error("operation failed", err);

    const [, fields] = mockLoggerError.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const serialized = fields["error"] as Record<string, unknown>;
    expect(serialized.cause).toBeDefined();
    const serializedCause = serialized.cause as Record<string, unknown>;
    expect(serializedCause.message).toBe("original cause");
    expect(typeof serializedCause.stack).toBe("string");
  });
});
