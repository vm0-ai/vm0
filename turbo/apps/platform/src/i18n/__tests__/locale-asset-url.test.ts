import { describe, expect, it } from "vitest";
import { resolveLocaleAssetUrl } from "../locale-asset-url.ts";

describe("locale asset URLs", () => {
  it("uses the standalone Worker preview's same-origin asset proxy", () => {
    expect(
      resolveLocaleAssetUrl(
        "https://static.okou.io/okou-app/assets/ja-JP-test.json?v=1",
        "https://pr-31304-app-okou-app-preview.vm0.workers.dev/ja/sign-in",
      ).toString(),
    ).toBe(
      "https://pr-31304-app-okou-app-preview.vm0.workers.dev/okou-app/assets/ja-JP-test.json?v=1",
    );
  });

  it("keeps production and legacy preview CDN URLs unchanged", () => {
    const resourceUrl =
      "https://static.okou.io/okou-app/assets/fr-FR-test.json";

    expect(
      resolveLocaleAssetUrl(resourceUrl, "https://app.okou.ai/fr/agents"),
    ).toStrictEqual(new URL(resourceUrl));
    expect(
      resolveLocaleAssetUrl(resourceUrl, "https://pr-31304-app.omby.ai/fr"),
    ).toStrictEqual(new URL(resourceUrl));
    expect(
      resolveLocaleAssetUrl(resourceUrl, "https://app.vm0.ai/fr/agents"),
    ).toStrictEqual(new URL(resourceUrl));
  });

  it("does not proxy unrelated Worker preview resources", () => {
    const resourceUrl = "https://static.okou.io/public/locales/ja-JP.json";

    expect(
      resolveLocaleAssetUrl(
        resourceUrl,
        "https://pr-31304-app-okou-app-preview.vm0.workers.dev/ja",
      ),
    ).toStrictEqual(new URL(resourceUrl));
  });
});
