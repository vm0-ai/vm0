import { describe, it, expect } from "vitest";
import { markdownToImessagePlain } from "../format";

describe("markdownToImessagePlain", () => {
  it("returns empty string unchanged", () => {
    expect(markdownToImessagePlain("")).toBe("");
  });

  it("leaves plain text untouched", () => {
    expect(markdownToImessagePlain("hello world")).toBe("hello world");
  });

  it("strips bold markers", () => {
    expect(markdownToImessagePlain("see **this** now")).toBe("see this now");
    expect(markdownToImessagePlain("__loud__")).toBe("loud");
  });

  it("strips italic markers", () => {
    expect(markdownToImessagePlain("*soft* tone")).toBe("soft tone");
    expect(markdownToImessagePlain("a _hint_ of style")).toBe(
      "a hint of style",
    );
  });

  it("does not treat snake_case identifiers as italic", () => {
    expect(markdownToImessagePlain("call run_agent_now()")).toBe(
      "call run_agent_now()",
    );
  });

  it("strips inline code backticks", () => {
    expect(markdownToImessagePlain("run `npm test` first")).toBe(
      "run npm test first",
    );
  });

  it("strips fenced code block markers but keeps content", () => {
    expect(markdownToImessagePlain("```js\nconsole.log(1)\n```")).toBe(
      "console.log(1)",
    );
  });

  it("strips strikethrough markers", () => {
    expect(markdownToImessagePlain("~~old~~ new")).toBe("old new");
  });

  it("strips heading prefixes", () => {
    expect(markdownToImessagePlain("# Title\n\nBody")).toBe("Title\n\nBody");
    expect(markdownToImessagePlain("### Section")).toBe("Section");
  });

  it("converts unordered list markers to bullets", () => {
    expect(markdownToImessagePlain("- first\n- second\n* third")).toBe(
      "• first\n• second\n• third",
    );
  });

  it("preserves ordered list markers", () => {
    expect(markdownToImessagePlain("1. step one\n2. step two")).toBe(
      "1. step one\n2. step two",
    );
  });

  it("strips blockquote markers", () => {
    expect(markdownToImessagePlain("> a quote\n> over two lines")).toBe(
      "a quote\nover two lines",
    );
  });

  it("breaks links onto their own line so the URL can preview", () => {
    expect(
      markdownToImessagePlain("[the docs](https://example.com/docs)"),
    ).toBe("the docs\nhttps://example.com/docs");
  });

  it("collapses link to bare URL when label equals the URL", () => {
    expect(
      markdownToImessagePlain("[https://example.com](https://example.com)"),
    ).toBe("https://example.com");
  });

  it("handles images like links with an alt fallback", () => {
    expect(markdownToImessagePlain("![chart](https://example.com/c.png)")).toBe(
      "chart\nhttps://example.com/c.png",
    );
    expect(markdownToImessagePlain("![](https://example.com/c.png)")).toBe(
      "https://example.com/c.png",
    );
  });

  it("collapses long runs of blank lines", () => {
    expect(markdownToImessagePlain("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("combines multiple markers in one pass", () => {
    const input =
      "## Update\n\n- finished **task**\n- see [audit](https://example.com/logs/1)";
    expect(markdownToImessagePlain(input)).toBe(
      "Update\n\n• finished task\n• see audit\nhttps://example.com/logs/1",
    );
  });
});
