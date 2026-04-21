import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The platform app is an English-only admin UI. Browser auto-translation
// (notably Chrome Mobile on zh-TW locales) wraps text nodes in <font>
// elements, desyncing React 19's fiber tree from the real DOM and producing
// `removeChild` / `insertBefore` NotFoundError — see #10365. We ship
// `translate="no"` and `<meta name="google" content="notranslate">` in
// index.html as the opt-out; this test guards the attributes from being
// accidentally removed.
describe("platform index.html translation opt-out", () => {
  const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");

  it('sets translate="no" on the <html> element', () => {
    expect(html).toMatch(/<html[^>]*\btranslate="no"/);
  });

  it("includes the legacy Google notranslate meta tag", () => {
    expect(html).toMatch(
      /<meta[^>]*\bname="google"[^>]*\bcontent="notranslate"/,
    );
  });
});
