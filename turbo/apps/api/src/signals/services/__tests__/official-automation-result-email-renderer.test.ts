import { describe, expect, it } from "vitest";

import {
  OFFICIAL_AUTOMATION_RESULT_EMAIL_HTML_MAX_BYTES,
  renderOfficialAutomationResultEmail,
} from "../official-automation-result-email-renderer";

const RUN_URL = "https://app.okou.ai/activities/run_test";
const MANAGE_URL = "https://app.okou.ai/email/unsubscribe?token=test";

function render(resultText: string) {
  return renderOfficialAutomationResultEmail(
    {
      title: "Result from Morning Brief",
      resultText,
      runUrl: RUN_URL,
      manageUrl: MANAGE_URL,
    },
    "okou",
  );
}

function hrefs(html: string): readonly string[] {
  return Array.from(html.matchAll(/href="([^"]+)"/gu), (match) => {
    return match[1]!;
  });
}

describe("Official Automation result email renderer", () => {
  it("renders the supported Markdown subset with inline email styles", () => {
    const result = render(
      [
        "# Weekly priorities",
        "",
        "First line  ",
        "second line with **strong**, *emphasis*, and ~~removed~~ text.",
        "",
        "1. First ordered item",
        "2. Second ordered item",
        "",
        "- First bullet",
        "- Second bullet",
        "",
        "> A quoted decision",
        "",
        "Use `inlineCode()` here.",
        "",
        "```typescript",
        "const answer = 42 < 100;",
        "```",
        "",
        "---",
        "",
        "[Customer](https://example.com/customer)",
        "",
        "| Owner | Priority |",
        "| --- | --- |",
        "| Sales | High |",
      ].join("\n"),
    );

    expect(result.fallback).toBeNull();
    expect(result.html).toContain(">Weekly priorities</h1>");
    expect(result.html).toContain("<p style=");
    expect(result.html).toContain("<br>\nsecond line");
    expect(result.html).toContain("<strong style=");
    expect(result.html).toContain("<em style=");
    expect(result.html).toContain("<s style=");
    expect(result.html).toContain("<ol style=");
    expect(result.html).toContain("<ul style=");
    expect(result.html).toContain("<li style=");
    expect(result.html).toContain("<blockquote style=");
    expect(result.html).toContain("<code style=");
    expect(result.html).toContain("<pre style=");
    expect(result.html).toContain("const answer = 42 &lt; 100;");
    expect(result.html).toContain("margin:20px 0;border:0");
    expect(result.html).toContain('<table role="presentation" width="100%"');
    expect(result.html).toContain("<th style=");
    expect(result.html).toContain("<td style=");
    expect(result.html).toContain('href="https://example.com/customer"');
    expect(result.html).toContain("table-layout:fixed");
    expect(result.html).toContain("overflow-wrap:anywhere");
    expect(result.text.toLowerCase()).toContain("weekly priorities");
    expect(result.text).toContain("https://example.com/customer");
    expect(result.text).toContain(RUN_URL);
    expect(result.text).toContain(MANAGE_URL);
  });

  it("keeps raw HTML literal and never activates agent-authored elements or attributes", () => {
    const result = render(
      [
        '<script>alert("script")</script>',
        "<style>* { display:none }</style>",
        '<img src="https://tracker.example/pixel" onerror="alert(1)">',
        '<svg onload="alert(1)"><path /></svg>',
        '<iframe src="https://tracker.example/frame"></iframe>',
        '<div onclick="alert(1)">click</div>',
      ].join("\n"),
    );

    expect(result.fallback).toBeNull();
    expect(result.html).not.toContain("<script>");
    expect(result.html).not.toContain("<style>");
    expect(result.html).not.toContain("<img");
    expect(result.html).not.toContain("<svg");
    expect(result.html).not.toContain("<iframe");
    expect(result.html).not.toMatch(/<[^>]+\son(?:click|error|load)=/u);
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.html).toContain("&lt;style&gt;");
    expect(result.html).toContain("&lt;img src=&quot;");
    expect(result.html).toContain("&lt;svg onload=&quot;");
    expect(result.html).toContain("&lt;iframe src=&quot;");
  });

  it("keeps normalized absolute https and mailto destinations clickable", () => {
    const result = render(
      [
        "[Web](h&#x74;tps://example.com/a?x=1&amp;y=2)",
        "[Email](MAILTO:user@example.com?subject=Hello)",
      ].join("\n\n"),
    );

    expect(hrefs(result.html)).toStrictEqual([
      "https://example.com/a?x=1&amp;y=2",
      "MAILTO:user@example.com?subject=Hello",
      RUN_URL,
      MANAGE_URL,
    ]);
  });

  it.each([
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html;base64,PHNjcmlwdD4="],
    ["file", "file:///etc/passwd"],
    ["cid", "cid:tracking-pixel"],
    ["entity-obfuscated", "java&#x73;cript:alert(1)"],
    ["percent-obfuscated", "java%73cript:alert(1)"],
    ["protocol-relative", "//evil.example/path"],
    ["root-relative", "/relative/path"],
    ["relative", "../relative/path"],
    ["http", "http://example.com/path"],
    ["other-scheme", "ftp://example.com/file"],
    ["malformed-https", "https://%zz.example/path"],
    ["non-absolute-https", "https:relative/path"],
    ["empty-mailto", "mailto:"],
  ])("preserves the %s label without an href", (label, destination) => {
    const result = render(`[${label}](${destination})`);

    expect(result.html).toContain(label);
    expect(hrefs(result.html)).toStrictEqual([RUN_URL, MANAGE_URL]);
  });

  it("suppresses Markdown images and preserves readable alt text", () => {
    const result = render(
      "Before ![**Quarterly** report](https://tracker.example/pixel.png) after",
    );

    expect(result.html).not.toContain("<img");
    expect(result.html).not.toContain("tracker.example");
    expect(result.html).toContain("Before Quarterly report after");
    expect(result.text).toContain("Before Quarterly report after");
  });

  it("renders Mermaid and every other fence as inert wrapping code", () => {
    const result = render(
      ["```mermaid", "graph TD", "A[Start] --> B[Done]", "```"].join("\n"),
    );

    expect(result.html).toContain("<pre style=");
    expect(result.html).toContain("graph TD");
    expect(result.html).toContain("A[Start] --&gt; B[Done]");
    expect(result.html).not.toContain("<svg");
    expect(result.html).not.toContain('class="language-mermaid"');
  });

  it("preserves Unicode and the Unicode-safe truncation marker", () => {
    const result = render("Priority 😀 東京 café\n\n[Result truncated]");

    expect(result.html).toContain("Priority 😀 東京 café");
    expect(result.html).toContain("[Result truncated]");
    expect(result.text).toContain("Priority 😀 東京 café");
    expect(result.text).toContain("[Result truncated]");
  });

  it("renders malformed Markdown deterministically as readable text", () => {
    const source = "Unclosed **strong and [link](https://example.com";

    expect(render(source)).toStrictEqual(render(source));
    expect(render(source).html).toContain("Unclosed **strong and [link]");
  });

  it("falls back to bounded preformatted HTML when styled markup expands past 96 KiB", () => {
    const pathologicalResult = Array.from({ length: 2000 }, () => {
      return "- x";
    }).join("\n");
    expect(Array.from(pathologicalResult)).toHaveLength(7999);

    const result = render(pathologicalResult);

    expect(result.fallback).toMatchObject({
      reason: "size-limit",
      fallbackHtmlBytes: Buffer.byteLength(result.html, "utf8"),
    });
    expect(result.fallback?.attemptedHtmlBytes).toBeGreaterThan(
      OFFICIAL_AUTOMATION_RESULT_EMAIL_HTML_MAX_BYTES,
    );
    expect(Buffer.byteLength(result.html, "utf8")).toBeLessThanOrEqual(
      OFFICIAL_AUTOMATION_RESULT_EMAIL_HTML_MAX_BYTES,
    );
    expect(result.html).toContain("white-space:pre-wrap");
    expect(result.html).not.toContain("<li");
    expect(result.html).toContain("- x\n- x");
    expect(result.text).toContain("- x\n- x");
  });

  it("falls back without exposing raw HTML when Markdown rendering throws", () => {
    const source = '<script>fallback & "safe"</script>';
    const nonStringIterable = {
      [Symbol.iterator]: () => {
        return source[Symbol.iterator]();
      },
    } as unknown as string;

    const result = render(nonStringIterable);

    expect(result.fallback).toMatchObject({
      reason: "render-error",
      attemptedHtmlBytes: null,
      fallbackHtmlBytes: Buffer.byteLength(result.html, "utf8"),
    });
    expect(result.html).toContain("white-space:pre-wrap");
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain(
      "&lt;script&gt;fallback &amp; &quot;safe&quot;&lt;/script&gt;",
    );
    expect(Buffer.byteLength(result.html, "utf8")).toBeLessThanOrEqual(
      OFFICIAL_AUTOMATION_RESULT_EMAIL_HTML_MAX_BYTES,
    );
    expect(result.text).toContain('<script>fallback & "safe"</script>');
  });
});
