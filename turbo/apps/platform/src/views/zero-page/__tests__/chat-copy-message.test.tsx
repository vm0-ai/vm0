/**
 * Tests for copyMessageContent$ signal (clipboard copy with iOS fallback).
 *
 * Entry point: store.set(copyMessageContent$, messageId, content, signal)
 * Mock (external): navigator.clipboard, document.execCommand
 * Real (internal): signals, state management
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  copyMessageContent$,
  copiedMessageIdValue$,
} from "../../../signals/zero-page/zero-session-chat-ui.ts";

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

describe("copyMessageContent$", () => {
  let writeTextMock: ReturnType<typeof setupClipboardMock>;

  beforeEach(() => {
    writeTextMock = setupClipboardMock();
  });

  it("copies text via clipboard API and sets copied state", async () => {
    writeTextMock.mockResolvedValue(undefined);

    await context.store.set(
      copyMessageContent$,
      "msg-1",
      "Hello world",
      context.signal,
    );

    expect(writeTextMock).toHaveBeenCalledWith("Hello world");
    expect(context.store.get(copiedMessageIdValue$)).toBe("msg-1");
  });

  it("falls back to execCommand when clipboard API throws", async () => {
    writeTextMock.mockRejectedValue(
      new DOMException("Not allowed", "NotAllowedError"),
    );
    const execMock = vi.fn().mockReturnValue(true);
    document.execCommand = execMock;

    await context.store.set(
      copyMessageContent$,
      "msg-2",
      "Fallback text",
      context.signal,
    );

    expect(writeTextMock).toHaveBeenCalledWith("Fallback text");
    expect(execMock).toHaveBeenCalledWith("copy");
    // Should still mark as copied after successful fallback
    expect(context.store.get(copiedMessageIdValue$)).toBe("msg-2");
  });

  it("does not set copied state when both methods fail", async () => {
    writeTextMock.mockRejectedValue(
      new DOMException("Not allowed", "NotAllowedError"),
    );
    document.execCommand = () => {
      throw new Error("execCommand failed");
    };

    // Should not throw — error is fully contained
    await context.store.set(
      copyMessageContent$,
      "msg-3",
      "Some text",
      context.signal,
    );

    expect(context.store.get(copiedMessageIdValue$)).toBeNull();
  });
});
