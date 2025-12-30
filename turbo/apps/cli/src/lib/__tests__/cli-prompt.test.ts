import { describe, it, expect, afterEach } from "vitest";
import { isInteractive } from "../cli-prompt";

describe("cli-prompt", () => {
  describe("isInteractive", () => {
    const originalIsTTY = process.stdin.isTTY;

    afterEach(() => {
      // Restore original value
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTTY,
        writable: true,
      });
    });

    it("should return true when stdin is a TTY", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
      });
      expect(isInteractive()).toBe(true);
    });

    it("should return false when stdin is not a TTY", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        writable: true,
      });
      expect(isInteractive()).toBe(false);
    });

    it("should return false when stdin.isTTY is undefined", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        writable: true,
      });
      expect(isInteractive()).toBe(false);
    });
  });

  // Note: confirmPrompt is difficult to test without mocking readline
  // The actual confirmation flow will be tested via integration tests
});
