/**
 * Tests for instrument.ts EPIPE handling
 *
 * Tests process-level behavior following CLI testing principles:
 * - Entry point: instrument.ts side-effect import (CLI initialization)
 * - Mock (external): None
 * - Real (internal): process.stdout/stderr error event handlers
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Import instrument.ts to register the EPIPE handler as a side effect
import "../instrument";

describe("EPIPE handling", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    mockExit.mockClear();
  });

  it("should exit cleanly when stdout encounters EPIPE", () => {
    const epipeError: NodeJS.ErrnoException = new Error("write EPIPE");
    epipeError.code = "EPIPE";

    expect(() => {
      process.stdout.emit("error", epipeError);
    }).toThrow("process.exit called");

    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("should exit cleanly when stderr encounters EPIPE", () => {
    const epipeError: NodeJS.ErrnoException = new Error("write EPIPE");
    epipeError.code = "EPIPE";

    expect(() => {
      process.stderr.emit("error", epipeError);
    }).toThrow("process.exit called");

    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("should re-throw non-EPIPE errors on stdout", () => {
    const otherError: NodeJS.ErrnoException = new Error("some other error");
    otherError.code = "EACCES";

    expect(() => {
      process.stdout.emit("error", otherError);
    }).toThrow("some other error");

    expect(mockExit).not.toHaveBeenCalled();
  });

  it("should re-throw non-EPIPE errors on stderr", () => {
    const otherError: NodeJS.ErrnoException = new Error("permission denied");
    otherError.code = "EACCES";

    expect(() => {
      process.stderr.emit("error", otherError);
    }).toThrow("permission denied");

    expect(mockExit).not.toHaveBeenCalled();
  });
});
