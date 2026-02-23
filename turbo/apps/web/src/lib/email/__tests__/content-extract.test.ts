import { describe, it, expect } from "vitest";
import { extractEmailBody } from "../content-extract";

describe("extractEmailBody", () => {
  it("should prefer HTML over text when both are available", () => {
    const result = extractEmailBody(
      "<p>HTML content</p>",
      "Plain text content",
    );
    expect(result).toContain("HTML content");
    expect(result).not.toContain("Plain text content");
  });

  it("should fallback to text when HTML is empty", () => {
    const result = extractEmailBody("", "Plain text content");
    expect(result).toBe("Plain text content");
  });

  it("should strip HTML tags and convert to readable text", () => {
    const html = `
      <h1>Newsletter</h1>
      <p>Welcome to our <strong>weekly digest</strong>.</p>
      <ul>
        <li>Item one</li>
        <li>Item two</li>
      </ul>
    `;
    const result = extractEmailBody(html, "");
    expect(result.toLowerCase()).toContain("newsletter");
    expect(result).toContain("weekly digest");
    expect(result).toContain("Item one");
    expect(result).toContain("Item two");
    expect(result).not.toContain("<p>");
    expect(result).not.toContain("<strong>");
  });

  it("should preserve links as text", () => {
    const html = '<p>Visit <a href="https://example.com">our site</a>.</p>';
    const result = extractEmailBody(html, "");
    expect(result).toContain("our site");
    expect(result).toContain("https://example.com");
  });

  it("should return empty string when both HTML and text are empty", () => {
    const result = extractEmailBody("", "");
    expect(result).toBe("");
  });

  it("should strip quoted replies from converted HTML", () => {
    const text =
      "New reply\n\nOn Jan 1, 2026, user@example.com wrote:\n> Original message";
    const result = extractEmailBody("", text);
    expect(result).toContain("New reply");
    expect(result).not.toContain("Original message");
  });
});
