import { describe, expect, it } from "vitest";
import indexHtml from "../../index.html?raw";

type BrowserUpgradeTarget = {
  actionLabel: string;
  actionUrl: string;
  description: string;
  title: string;
};

const indexDocument = new DOMParser().parseFromString(indexHtml, "text/html");
const browserSupportScript = Array.from(
  indexDocument.querySelectorAll("script"),
)
  .map((script) => script.textContent ?? "")
  .find((scriptContent) => scriptContent.includes("__vm0BrowserSupported"));

if (!browserSupportScript) {
  throw new Error("Browser support gate script is missing from index.html");
}

const getBrowserSupportResult = (
  userAgent: string,
): {
  browserSupportedAttribute: string | undefined;
  blocked: boolean;
  supported: boolean | undefined;
  upgradeTarget: BrowserUpgradeTarget | undefined;
} => {
  let browserSupportedAttribute: string | undefined;
  let blocked = false;
  const windowState: {
    __vm0BrowserUpgrade?: BrowserUpgradeTarget;
    __vm0BrowserSupported?: boolean;
  } = {};
  const runBrowserSupportScript = new Function(
    "document",
    "navigator",
    "window",
    browserSupportScript,
  );

  runBrowserSupportScript(
    {
      documentElement: {
        setAttribute(name: string, value: string) {
          if (name !== "data-browser-supported") {
            return;
          }

          browserSupportedAttribute = value;
          blocked = value === "false";
        },
      },
    },
    { userAgent },
    windowState,
  );

  return {
    browserSupportedAttribute,
    blocked,
    supported: windowState.__vm0BrowserSupported,
    upgradeTarget: windowState.__vm0BrowserUpgrade,
  };
};

// The platform app is an English-only admin UI. Browser auto-translation
// (notably Chrome Mobile on zh-TW locales) wraps text nodes in <font>
// elements, desyncing React 19's fiber tree from the real DOM and producing
// `removeChild` / `insertBefore` NotFoundError — see #10365. We ship
// `translate="no"` and `<meta name="google" content="notranslate">` in
// index.html as the opt-out; this test guards the attributes from being
// accidentally removed.
describe("platform index.html translation opt-out", () => {
  it('sets translate="no" on the <html> element', () => {
    expect(indexHtml).toMatch(/<html[^>]*\btranslate="no"/);
  });

  it("includes the legacy Google notranslate meta tag", () => {
    expect(indexHtml).toMatch(
      /<meta[^>]*\bname="google"[^>]*\bcontent="notranslate"/,
    );
  });
});

describe("platform index.html marketing scripts", () => {
  it("gates Google Ads and LinkedIn pixels to production deployments", () => {
    expect(indexHtml).toContain('"%VITE_VERCEL_ENV%" !== "production"');
    expect(indexHtml).not.toMatch(
      /<script[^>]*\bsrc="https:\/\/www\.googletagmanager\.com\/gtag\/js/,
    );
    expect(indexHtml).not.toMatch(
      /<script[^>]*\bsrc="https:\/\/snap\.licdn\.com\/li\.lms-analytics\/insight\.min\.js/,
    );
    expect(indexHtml).not.toMatch(
      /<noscript[\s\S]*px\.ads\.linkedin\.com\/collect/,
    );
  });
});

describe("platform index.html browser support gate", () => {
  it("loads the app entry only after the browser support check passes", () => {
    expect(indexHtml).not.toMatch(
      /<script[^>]*\btype="module"[^>]*\bsrc="\/src\/main\.ts"/,
    );
    expect(indexHtml).toContain("window.__vm0BrowserSupported === true");
    expect(indexHtml).toContain('import("/src/main.ts")');
  });

  it("shows an upgrade page for browsers below the app CSS target", () => {
    expect(indexHtml).toContain("data-browser-supported");
    expect(indexHtml).toContain('[data-browser-supported="true"] #root');
    expect(indexHtml).toContain("Update your browser to continue");
    expect(indexHtml).toContain(
      "Zero does not support your current browser version",
    );
    expect(indexHtml.match(/<a\b/g)).toHaveLength(1);
  });

  it.each([
    [
      "Chrome 110",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
      false,
    ],
    [
      "Chrome 111",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36",
      true,
    ],
    [
      "Safari 16.3",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Safari/605.1.15",
      false,
    ],
    [
      "Safari 16.4",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15",
      true,
    ],
    [
      "Chrome on iOS 16.3",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/112.0.0.0 Mobile/15E148 Safari/604.1",
      false,
    ],
    [
      "Chrome on iOS 16.4",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/112.0.0.0 Mobile/15E148 Safari/604.1",
      true,
    ],
    [
      "unknown browser",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 CustomBrowser/1.0",
      true,
    ],
  ])("classifies %s support from the user agent", (_, userAgent, expected) => {
    expect(getBrowserSupportResult(userAgent)).toMatchObject({
      browserSupportedAttribute: String(expected),
      blocked: !expected,
      supported: expected,
    });
  });

  it.each([
    [
      "Chrome",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
      "Update Chrome",
    ],
    [
      "HeadlessChrome",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/147.0.0.0 Safari/537.36",
      "Update Chrome",
    ],
    [
      "Safari",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Safari/605.1.15",
      "Update Safari",
    ],
    [
      "iOS",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/112.0.0.0 Mobile/15E148 Safari/604.1",
      "Update iOS",
    ],
  ])(
    "sets a single %s-specific upgrade action",
    (_, userAgent, actionLabel) => {
      expect(getBrowserSupportResult(userAgent).upgradeTarget).toMatchObject({
        actionLabel,
        description: expect.stringContaining(
          "Zero does not support your current browser version",
        ),
      });
    },
  );
});
