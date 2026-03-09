import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  markdownToTelegramHtml,
  splitMessage,
  buildTelegramResponse,
} from "../format";

describe("escapeHtml", () => {
  it("should escape &, <, >", () => {
    expect(escapeHtml("a < b > c & d")).toBe("a &lt; b &gt; c &amp; d");
  });

  it("should leave normal text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("markdownToTelegramHtml", () => {
  it("should convert bold", () => {
    expect(markdownToTelegramHtml("**bold**")).toBe("<b>bold</b>");
  });

  it("should convert italic", () => {
    expect(markdownToTelegramHtml("*italic*")).toBe("<i>italic</i>");
  });

  it("should convert inline code", () => {
    expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>");
  });

  it("should convert code blocks", () => {
    expect(markdownToTelegramHtml("```js\nconsole.log(1)\n```")).toBe(
      "<pre>console.log(1)\n</pre>",
    );
  });

  it("should convert links", () => {
    expect(markdownToTelegramHtml("[click](https://example.com)")).toBe(
      '<a href="https://example.com">click</a>',
    );
  });

  it("should convert images to clickable links", () => {
    expect(
      markdownToTelegramHtml("![screenshot](https://example.com/img.png)"),
    ).toBe('<a href="https://example.com/img.png">🖼 screenshot</a>');
  });

  it("should use default alt text for images without alt", () => {
    expect(markdownToTelegramHtml("![](https://example.com/img.png)")).toBe(
      '<a href="https://example.com/img.png">🖼 image</a>',
    );
  });

  it("should handle mixed formatting", () => {
    const input = "Hello **bold** and *italic* with `code`";
    const expected =
      "Hello <b>bold</b> and <i>italic</i> with <code>code</code>";
    expect(markdownToTelegramHtml(input)).toBe(expected);
  });

  it("should escape HTML entities in plain text", () => {
    expect(markdownToTelegramHtml("a < b & c > d")).toBe(
      "a &lt; b &amp; c &gt; d",
    );
  });

  it("should escape HTML entities inside formatted text", () => {
    expect(markdownToTelegramHtml("**a < b**")).toBe("<b>a &lt; b</b>");
  });
});

describe("buildTelegramResponse", () => {
  it("should include agent name header, content, and footer", () => {
    const result = buildTelegramResponse(
      "Hello world",
      "TestBot",
      "https://example.com/logs/123",
    );

    expect(result).toContain("🤖 <b>TestBot</b>");
    expect(result).toContain("Hello world");
    expect(result).toContain(
      '<a href="https://example.com/logs/123">📋 View logs</a>',
    );
  });

  it("should separate header, content, and footer with line breaks", () => {
    const result = buildTelegramResponse(
      "content",
      "Bot",
      "https://example.com/logs",
    );

    // Header + blank line + content + blank line + footer
    expect(result).toMatch(/^🤖 <b>Bot<\/b>\n\ncontent\n\n/);
  });

  it("should escape HTML in agent name", () => {
    const result = buildTelegramResponse(
      "hi",
      "Bot <script>",
      "https://example.com/logs",
    );

    expect(result).toContain("🤖 <b>Bot &lt;script&gt;</b>");
  });

  it("should convert markdown content to Telegram HTML", () => {
    const result = buildTelegramResponse(
      "**bold** and `code`",
      "Bot",
      "https://example.com/logs",
    );

    expect(result).toContain("<b>bold</b> and <code>code</code>");
  });

  it("should include deep links when provided", () => {
    const result = buildTelegramResponse(
      "content",
      "Bot",
      "https://example.com/logs",
      [
        {
          emoji: "🔑",
          label: "Configure model providers",
          url: "https://example.com/settings",
        },
      ],
    );

    expect(result).toContain(
      '🔑 <a href="https://example.com/settings">Configure model providers</a>',
    );
    expect(result).toContain("📋 View logs</a>");
  });

  it("should not include deep links section when empty", () => {
    const result = buildTelegramResponse(
      "content",
      "Bot",
      "https://example.com/logs",
      [],
    );

    expect(result).not.toContain("🔑");
    expect(result).toContain("📋 View logs</a>");
  });
});

describe("splitMessage", () => {
  it("should return single chunk for short messages", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("should split at paragraph boundaries", () => {
    const maxLen = 20;
    const text = "first paragraph\n\nsecond paragraph";
    const chunks = splitMessage(text, maxLen);
    expect(chunks).toEqual(["first paragraph", "second paragraph"]);
  });

  it("should split at line boundaries when no paragraph break", () => {
    const maxLen = 15;
    const text = "line one\nline two\nline three";
    const chunks = splitMessage(text, maxLen);
    expect(chunks[0]).toBe("line one");
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("should hard-cut when no boundaries available", () => {
    const maxLen = 10;
    const text = "a".repeat(25);
    const chunks = splitMessage(text, maxLen);
    expect(chunks).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
  });

  it("should not break code blocks mid-block", () => {
    const maxLen = 30;
    const text = "intro text\n\n```\ncode line 1\ncode line 2\n```";
    const chunks = splitMessage(text, maxLen);
    // The code block should be in a single chunk
    const codeChunk = chunks.find((c) => c.includes("```"));
    expect(codeChunk).toBeDefined();
    const backtickCount = (codeChunk!.match(/```/g) ?? []).length;
    expect(backtickCount % 2).toBe(0);
  });

  it("should respect default max length of 4096", () => {
    const text = "x".repeat(8000);
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });
});
