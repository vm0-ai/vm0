/**
 * Tests for clipboard signals (shared writeToClipboard + copyToClipboard$).
 *
 * Entry point: store.set(copyToClipboard$, text, signal)
 * Mock (external): navigator.clipboard, document.execCommand
 * Real (internal): signals, state management
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { testContext } from "../../__tests__/test-helpers.ts";
import { copyToClipboard$, copyStatus$ } from "../clipboard.ts";

const context = testContext();

function setupClipboardMock() {
  const writeTextMock = vi.fn<(data: string) => Promise<void>>();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    writable: true,
    configurable: true,
  });
  return writeTextMock;
}

describe("copyToClipboard$", () => {
  let writeTextMock: ReturnType<typeof setupClipboardMock>;

  beforeEach(() => {
    writeTextMock = setupClipboardMock();
  });

  it("copies text and sets status to copied", async () => {
    writeTextMock.mockResolvedValue(undefined);

    await context.store.set(copyToClipboard$, "hello", context.signal);

    expect(writeTextMock).toHaveBeenCalledWith("hello");
    expect(context.store.get(copyStatus$)).toBe("copied");
  });

  it("falls back to execCommand when clipboard API throws", async () => {
    writeTextMock.mockRejectedValue(
      new DOMException("Not allowed", "NotAllowedError"),
    );
    const execMock = vi.fn().mockReturnValue(true);
    document.execCommand = execMock;

    await context.store.set(copyToClipboard$, "fallback text", context.signal);

    expect(execMock).toHaveBeenCalledWith("copy");
    expect(context.store.get(copyStatus$)).toBe("copied");
  });

  it("stays idle when both methods fail", async () => {
    writeTextMock.mockRejectedValue(
      new DOMException("Not allowed", "NotAllowedError"),
    );
    document.execCommand = () => {
      throw new Error("execCommand failed");
    };

    await context.store.set(copyToClipboard$, "some text", context.signal);

    expect(context.store.get(copyStatus$)).toBe("idle");
  });
});
