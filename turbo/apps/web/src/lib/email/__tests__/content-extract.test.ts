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

  it("preserves forwarded email content that previously triggered regex bug", () => {
    // Regression test: email-reply-parser had a CJK quote header regex that
    // catastrophically over-matched via [\s\S]+ (crossing newlines), swallowing
    // all content between any line starting with a common CJK character and the
    // quote attribution suffix. This test ensures forwarded content is preserved.
    const html = [
      "<div>Please review the email thread and summarize the conversation.</div>",
      "<div><br></div>",
      "<div>Based on this, please do some research.</div>",
      "<div><br></div>",
      '<div class="gmail_quote">',
      "  <div>---------- Forwarded message ----------</div>",
      "  <div>From: Ethan Zhang &lt;ethan@vm0.ai&gt;</div>",
      "  <div>Date: March 5, 2026</div>",
      "  <br>",
      "  <div>Can you forward this to the agent?</div>",
      "  <blockquote>",
      "    Chenyu Lan &lt;lancy@vm0.ai&gt; on March 5 wrote:<br>",
      "    Let us discuss this tomorrow or create an issue instead.",
      "  </blockquote>",
      "</div>",
    ].join("\n");

    const result = extractEmailBody(html, "");

    expect(result).toContain("summarize the conversation");
    expect(result).toContain("Based on this");
    expect(result).toContain("Forwarded message");
    expect(result).toContain("Ethan Zhang");
    expect(result).toContain("forward this to the agent");
    expect(result).toContain("discuss this tomorrow");
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
