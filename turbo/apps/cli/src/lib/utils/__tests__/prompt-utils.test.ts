/**
 * Tests for stdin/prompt helpers in prompt-utils.
 *
 * Regression coverage for the piped-stdin detection bug: `isTTY === false`
 * never matched (isTTY is `undefined`, not `false`, when stdin is piped), so
 * piped input was silently dropped. `readPipedStdin` must read piped/redirected
 * stdin and only skip the read for an interactive terminal.
 *
 * The `node:fs` boundary is mocked so the `/dev/stdin` read is observable
 * without setting up a real pipe; all other fs exports remain real.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { readPipedStdin } from "../prompt-utils";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn() };
});

const mockReadFileSync = vi.mocked(readFileSync);

describe("readPipedStdin", () => {
  const originalIsTTY = process.stdin.isTTY;

  function setIsTTY(value: boolean | undefined) {
    Object.defineProperty(process.stdin, "isTTY", {
      value,
      writable: true,
      configurable: true,
    });
  }

  afterEach(() => {
    setIsTTY(originalIsTTY);
    mockReadFileSync.mockReset();
  });

  it("returns trimmed piped text when stdin is piped (isTTY undefined)", () => {
    setIsTTY(undefined);
    mockReadFileSync.mockReturnValue("  hello from stdin\n");

    expect(readPipedStdin()).toBe("hello from stdin");
    expect(mockReadFileSync).toHaveBeenCalledWith("/dev/stdin", "utf8");
  });

  it("returns piped text when stdin is redirected (isTTY false)", () => {
    setIsTTY(false);
    mockReadFileSync.mockReturnValue("redirected input");

    expect(readPipedStdin()).toBe("redirected input");
  });

  it("returns undefined for an interactive terminal without reading stdin", () => {
    setIsTTY(true);

    expect(readPipedStdin()).toBeUndefined();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("returns undefined when piped stdin is empty or whitespace only", () => {
    setIsTTY(undefined);
    mockReadFileSync.mockReturnValue("   \n  ");

    expect(readPipedStdin()).toBeUndefined();
  });

  it("returns undefined when stdin is not readable (read throws)", () => {
    setIsTTY(undefined);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENXIO: no such device or address");
    });

    expect(readPipedStdin()).toBeUndefined();
  });
});
