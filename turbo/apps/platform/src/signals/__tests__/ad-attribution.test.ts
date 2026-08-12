import { describe, expect, it } from "vitest";

import { adAttributionMetadataFromStoredValue } from "../bootstrap/ad-attribution.ts";

describe("ga4 client id attribution", () => {
  it("extracts the GA4 client ID from the shared _ga cookie", () => {
    const storedAttribution = new URLSearchParams({
      source_type: "paid",
      gclid: "click-123",
      utm_source: "google",
      utm_medium: "cpc",
      vm0_campaign_id: "24006983243",
      vm0_ad_group_id: "12345",
    }).toString();

    expect(
      adAttributionMetadataFromStoredValue(
        storedAttribution,
        "_ga=GA1.1.123456789.987654321",
      ),
    ).toStrictEqual({
      source_type: "paid",
      gclid: "click-123",
      gclid_present: "true",
      utm_source: "google",
      utm_medium: "cpc",
      vm0_campaign_id: "24006983243",
      vm0_ad_group_id: "12345",
      ga_client_id: "123456789.987654321",
    });
  });

  it("returns the GA4 client ID even when no ad click was stored", () => {
    expect(
      adAttributionMetadataFromStoredValue(
        null,
        "_ga=GA1.1.123456789.987654321",
      ),
    ).toStrictEqual({ ga_client_id: "123456789.987654321" });
  });

  it("ignores malformed analytics cookies", () => {
    expect(
      adAttributionMetadataFromStoredValue(null, "_ga=not-a-ga-cookie"),
    ).toBeUndefined();
  });
});
