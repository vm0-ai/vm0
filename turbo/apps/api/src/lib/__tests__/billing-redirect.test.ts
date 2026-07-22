import { beforeEach, describe, expect, it } from "vitest";

import { billingRedirectAllowed } from "../billing-redirect";
import { mockEnv } from "../env";

describe("billingRedirectAllowed", () => {
  beforeEach(() => {
    mockEnv("APP_URL", "https://app.vm7.ai:8443");
  });

  it("accepts the configured app origin", () => {
    expect(
      billingRedirectAllowed(
        "https://app.vm7.ai:8443/onboarding?billing=success",
      ),
    ).toBeTruthy();
  });

  it("rejects a non-App origin", () => {
    expect(
      billingRedirectAllowed("https://example.com/onboarding?billing=success"),
    ).toBeFalsy();
  });
});
