import { describe, expect, it } from "vitest";

import { renderConnectorHelpMarkdown } from "./connector-help-text.ts";

describe("renderConnectorHelpMarkdown", () => {
  it("renders supported connector help markdown", () => {
    expect(
      renderConnectorHelpMarkdown(
        "Use **test mode** and [open docs](https://example.com/docs).\n> Keep this key private.",
      ),
    ).toBe(
      'Use <strong>test mode</strong> and <a href="https://example.com/docs" target="_blank" rel="noopener noreferrer" class="text-primary underline">open docs</a>.\n<div class="pl-3 border-l-2 border-muted text-muted-foreground">Keep this key private.</div>',
    );
  });

  it("escapes unsupported or unsafe HTML", () => {
    expect(
      renderConnectorHelpMarkdown(
        '<img src=x onerror=alert(1)> [bad <b>label</b>](https://example.com/" onclick="alert(1)) **<script>bad()</script>**',
      ),
    ).toBe(
      "&lt;img src=x onerror=alert(1)&gt; [bad &lt;b&gt;label&lt;/b&gt;](https://example.com/&quot; onclick=&quot;alert(1)) <strong>&lt;script&gt;bad()&lt;/script&gt;</strong>",
    );
  });
});
