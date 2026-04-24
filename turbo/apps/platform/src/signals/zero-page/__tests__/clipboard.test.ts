/**
 * Tests for clipboard signals (shared writeToClipboard + copyToClipboard$).
 *
 * Entry point: store.set(copyToClipboard$, text, signal)
 * Mock (external): navigator.clipboard, document.execCommand
 * Real (internal): signals, state management
 */

import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  copyToClipboard$,
  copyStatus$,
  writeChatMessageToClipboard,
} from "../clipboard.ts";

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

interface TestClipboardItemInstance {
  items: Record<string, Blob>;
}

class TestClipboardItem implements TestClipboardItemInstance {
  readonly items: Record<string, Blob>;

  constructor(items: Record<string, Blob>) {
    this.items = items;
  }
}

function setupRichClipboardMock() {
  const writeMock = vi.fn<(items: ClipboardItem[]) => Promise<void>>();
  const writeTextMock = vi.fn<(data: string) => Promise<void>>();
  vi.stubGlobal("ClipboardItem", TestClipboardItem);
  Object.defineProperty(navigator, "clipboard", {
    value: { write: writeMock, writeText: writeTextMock },
    writable: true,
    configurable: true,
  });
  return { writeMock, writeTextMock };
}

describe("copyToClipboard$", () => {
  let writeTextMock: ReturnType<typeof setupClipboardMock>;

  beforeEach(() => {
    writeTextMock = setupClipboardMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

describe("writeChatMessageToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("writes image attachments as the same text and html payload as other files", async () => {
    const { writeMock } = setupRichClipboardMock();

    const ok = await writeChatMessageToClipboard({
      text: "Look at this",
      attachments: [
        {
          id: "file-1",
          filename: "photo.png",
          contentType: "image/png",
          size: 3,
          url: "http://localhost:3000/f/user-1/file-1/photo.png",
        },
      ],
    });

    expect(ok).toBeTruthy();
    const item = writeMock.mock.calls[0]?.[0][0] as unknown as
      | TestClipboardItemInstance
      | undefined;
    expect(item).toBeDefined();
    expect(item?.items["image/png"]).toBeUndefined();
    const html = await item!.items["text/html"]!.text();
    expect(html).toContain("data-vm0-chat-message");
    expect(html).toContain("<img");
    expect(html).toContain("Look at this");
    expect(html).toContain("photo.png");
    const text = await item!.items["text/plain"]!.text();
    expect(text).toContain("Look at this");
    expect(text).toContain("Attachments:");
    expect(text).toContain("photo.png");
  });
});
