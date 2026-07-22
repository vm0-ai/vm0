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

  it("rejects the retired WWW onboarding origin", () => {
    expect(
      billingRedirectAllowed(
        "https://www.vm7.ai:8443/onboarding?billing=success",
      ),
    ).toBeFalsy();
  });
});
