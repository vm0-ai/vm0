import { describe, expect, it } from "vitest";
import { extractEmailBody } from "../content-extract";

describe("extractEmailBody", () => {
  it("returns plain text when no HTML is provided", () => {
    const text = "Hello, this is a plain text email.";
    expect(extractEmailBody("", text)).toBe(text);
  });

  it("converts HTML to plain text", () => {
    const html = "<p>Hello</p><p>World</p>";
    const result = extractEmailBody(html, "fallback");
    expect(result).toContain("Hello");
    expect(result).toContain("World");
    expect(result).not.toContain("<p>");
  });

  it("preserves forwarded email content with Chinese text", () => {
    // This is the exact bug scenario: user text starting with "在" + forwarded
    // email containing "写道：" was previously stripped by email-reply-parser's
    // catastrophically greedy Chinese regex /^(在[\s\S]+写道：)$/m
    const html = [
      "<div>你仔细看一下我们的邮件交互，总结一下我们的对话。</div>",
      "<div><br></div>",
      "<div>在此基础上，请深度研究并创新一下。</div>",
      "<div><br></div>",
      '<div class="gmail_quote">',
      "  <div>---------- 转发的邮件 ----------</div>",
      "  <div>发件人： Ethan Zhang &lt;ethan@vm0.ai&gt;</div>",
      "  <div>日期：2026年3月5日</div>",
      "  <br>",
      "  <div>forward 给你的 agent</div>",
      "  <blockquote>",
      "    Chenyu Lan &lt;lancy@vm0.ai&gt; 于2026年3月5日写道：<br>",
      "    可以明天再聊聊，或者还是写一个 issue",
      "  </blockquote>",
      "</div>",
    ].join("\n");

    const result = extractEmailBody(html, "");

    expect(result).toContain("总结一下我们的对话");
    expect(result).toContain("在此基础上");
    expect(result).toContain("转发的邮件");
    expect(result).toContain("Ethan Zhang");
    expect(result).toContain("forward 给你的 agent");
    expect(result).toContain("可以明天再聊聊");
  });

  it("preserves nested blockquote reply content", () => {
    const html = [
      "<div>My new reply text.</div>",
      "<blockquote>",
      "  <div>Previous message content that should be preserved.</div>",
      "  <blockquote>",
      "    <div>Even older message content.</div>",
      "  </blockquote>",
      "</blockquote>",
    ].join("\n");

    const result = extractEmailBody(html, "");

    expect(result).toContain("My new reply text.");
    expect(result).toContain("Previous message content");
    expect(result).toContain("Even older message content");
  });

  it("replaces inline data URI images with placeholder", () => {
    const html =
      '<p>Check this image:</p><img src="data:image/png;base64,iVBORw0KGgo..." alt="screenshot">';

    const result = extractEmailBody(html, "");

    expect(result).toContain("Check this image:");
    expect(result).toContain("[inline image: screenshot]");
    expect(result).not.toContain("data:image/png");
    expect(result).not.toContain("iVBORw0KGgo");
  });

  it("returns empty string for empty inputs", () => {
    expect(extractEmailBody("", "")).toBe("");
  });

  it("preserves > prefixed lines in plain text", () => {
    const text = [
      "My reply here.",
      "",
      "> Previously quoted content",
      "> that spans multiple lines",
    ].join("\n");

    const result = extractEmailBody("", text);

    expect(result).toContain("My reply here.");
    expect(result).toContain("> Previously quoted content");
    expect(result).toContain("> that spans multiple lines");
  });
});
