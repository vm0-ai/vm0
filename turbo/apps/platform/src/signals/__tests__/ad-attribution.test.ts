import { afterEach, describe, expect, it } from "vitest";

import { getStoredAdAttributionMetadata } from "../bootstrap/ad-attribution.ts";

const STORED_AD_ATTRIBUTION_KEY = "vm0.adAttribution";

describe("ga4 client id attribution", () => {
  afterEach(() => {
    window.sessionStorage.removeItem(STORED_AD_ATTRIBUTION_KEY);
  });

  it("extracts the GA4 client ID from the shared _ga cookie", () => {
    window.sessionStorage.setItem(
      STORED_AD_ATTRIBUTION_KEY,
      new URLSearchParams({
        source_type: "paid",
        gclid: "click-123",
        utm_source: "google",
        utm_medium: "cpc",
      }).toString(),
    );

    expect(
      getStoredAdAttributionMetadata(
        window.sessionStorage,
        "_ga=GA1.1.123456789.987654321",
      ),
    ).toStrictEqual({
      source_type: "paid",
      gclid: "click-123",
      gclid_present: "true",
      utm_source: "google",
      utm_medium: "cpc",
      ga_client_id: "123456789.987654321",
    });
  });

  it("returns the GA4 client ID even when no ad click was stored", () => {
    expect(
      getStoredAdAttributionMetadata(
        window.sessionStorage,
        "_ga=GA1.1.123456789.987654321",
      ),
    ).toStrictEqual({ ga_client_id: "123456789.987654321" });
  });

  it("ignores malformed analytics cookies", () => {
    expect(
      getStoredAdAttributionMetadata(
        window.sessionStorage,
        "_ga=not-a-ga-cookie",
      ),
    ).toBeUndefined();
  });
});
