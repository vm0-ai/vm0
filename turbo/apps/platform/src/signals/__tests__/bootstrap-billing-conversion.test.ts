import { describe, expect, it } from "vitest";

import { googleAdsBillingConversionPayload } from "../bootstrap/billing-conversion.ts";

describe("googleAdsBillingConversionPayload", () => {
  it("builds Subscriber conversion payload for Pro checkout redirects", () => {
    expect(
      googleAdsBillingConversionPayload("pro", "cs_test_pro"),
    ).toStrictEqual({
      send_to: "AW-18144854014/3tdOCMimwK8cEP7_kcxD",
      value: 20,
      currency: "USD",
      transaction_id: "cs_test_pro",
    });
  });

  it("builds Subscriber conversion payload for Team checkout redirects", () => {
    expect(
      googleAdsBillingConversionPayload("team", "cs_test_team"),
    ).toStrictEqual({
      send_to: "AW-18144854014/3tdOCMimwK8cEP7_kcxD",
      value: 200,
      currency: "USD",
      transaction_id: "cs_test_team",
    });
  });

  it("ignores non-success billing redirects", () => {
    expect(
      googleAdsBillingConversionPayload("canceled", "cs_test_canceled"),
    ).toBeNull();
  });
});
