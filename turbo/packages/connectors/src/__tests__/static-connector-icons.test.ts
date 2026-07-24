import { describe, expect, it } from "vitest";

import { CONNECTOR_TYPE_KEYS } from "../connectors";
import {
  connectorIconAssetUrl,
  getStaticConnectorIconMetadata,
  isConnectorIconAssetKey,
  isStaticConnectorIconType,
  parseStaticConnectorIconAssetPath,
  staticConnectorIconPublicPathUrl,
} from "../static-connector-icons";

describe("static connector icons", () => {
  it("resolves every connector through the public static icon namespace", () => {
    const urls = new Set<string>();

    for (const type of CONNECTOR_TYPE_KEYS) {
      const metadata = getStaticConnectorIconMetadata(type);
      const url = new URL(metadata.url);
      urls.add(metadata.url);

      expect(url.protocol).toBe("https:");
      expect(url.origin).toBe("https://static.vm0.io");
      expect(url.pathname).toMatch(
        /^\/platform\/views\/zero-page\/components\/settings\/icons\/[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{12}\.(?:png|svg)$/u,
      );
      expect(url.hash).toBe("");
      expect(["", "?v=568fa471"]).toContain(url.search);
      if (url.search) {
        expect(type === "slack" || type === "slack-webhook").toBe(true);
      }
      if (metadata.scale !== undefined) {
        expect(metadata.scale).toBeGreaterThanOrEqual(1);
        expect(metadata.scale).toBeLessThanOrEqual(3);
      }
    }

    expect(urls.size).toBe(310);
  });

  it("preserves aliases and representative appearance behavior", () => {
    expect(getStaticConnectorIconMetadata("slack")).toStrictEqual({
      url: "https://static.vm0.io/platform/views/zero-page/components/settings/icons/slack-198390069136.svg?v=568fa471",
      invertInDarkMode: false,
      scale: 2.2,
    });
    expect(getStaticConnectorIconMetadata("slack-webhook")).toStrictEqual(
      getStaticConnectorIconMetadata("slack"),
    );
    expect(getStaticConnectorIconMetadata("railway-project").url).toBe(
      getStaticConnectorIconMetadata("railway").url,
    );
    expect(getStaticConnectorIconMetadata("test-oauth-device").url).toBe(
      getStaticConnectorIconMetadata("test-oauth").url,
    );
    expect(getStaticConnectorIconMetadata("airtable").invertInDarkMode).toBe(
      false,
    );
    expect(getStaticConnectorIconMetadata("github").invertInDarkMode).toBe(
      true,
    );
    expect(getStaticConnectorIconMetadata("openai").invertInDarkMode).toBe(
      true,
    );
  });

  it("distinguishes connector types from reusable asset keys", () => {
    expect(isStaticConnectorIconType("slack-webhook")).toBe(true);
    expect(isStaticConnectorIconType("unknown")).toBe(false);
    expect(isConnectorIconAssetKey("slack")).toBe(true);
    expect(isConnectorIconAssetKey("slack-webhook")).toBe(false);
    expect(connectorIconAssetUrl("slack")).toContain("/icons/slack-");
  });

  it("builds trusted URLs from full published icon paths", () => {
    expect(
      staticConnectorIconPublicPathUrl(
        "platform/views/zero-page/components/settings/icons/gmail-18f42e2c6f80.svg",
      ),
    ).toBe(
      "https://static.vm0.io/platform/views/zero-page/components/settings/icons/gmail-18f42e2c6f80.svg",
    );
    expect(
      staticConnectorIconPublicPathUrl("connector-icons/resolved-icon.svg"),
    ).toBe("https://static.vm0.io/connector-icons/resolved-icon.svg");
    expect(() => {
      staticConnectorIconPublicPathUrl(
        "https://example.com/platform/views/zero-page/components/settings/icons/gmail-18f42e2c6f80.svg",
      );
    }).toThrow("Invalid static connector icon public path");
    expect(() => {
      staticConnectorIconPublicPathUrl(
        "platform/views/zero-page/components/settings/icons/gmail-18f42e2c6f80.svg?v=1",
      );
    }).toThrow("Invalid static connector icon public path");
    expect(() => {
      staticConnectorIconPublicPathUrl("connector-icons/../gmail.svg");
    }).toThrow("Invalid static connector icon public path");
    expect(() => {
      staticConnectorIconPublicPathUrl("connector-icons/gmail.html");
    }).toThrow("Invalid static connector icon public path");
    expect(() => {
      staticConnectorIconPublicPathUrl(`${"a/".repeat(512)}icon.svg`);
    }).toThrow("Invalid static connector icon public path");
  });

  it.each([
    "https://evil.example/icon.svg",
    "../icons/github-150bd47f5db9.svg",
    "views/zero-page/components/settings/icons/../github-150bd47f5db9.svg",
    "views/zero-page/components/other/icons/github-150bd47f5db9.svg",
    "views/zero-page/components/settings/icons/github-150bd47f5db9.html",
    "views/zero-page/components/settings/icons/github-150bd47f5db9.svg?token=secret",
    "views/zero-page/components/settings/icons/github-150bd47f5db9.svg#fragment",
    "views/zero-page/components/settings/icons/slack-198390069136.svg",
  ])("rejects an unsafe or unsupported asset path: %s", (path) => {
    expect(() => {
      parseStaticConnectorIconAssetPath(path);
    }).toThrow("Invalid static connector icon asset path");
  });
});
