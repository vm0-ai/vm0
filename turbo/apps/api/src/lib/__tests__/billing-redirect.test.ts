import { describe, expect, it } from "vitest";

import { mockEnv, mockOptionalEnv } from "../env";
import { billingRedirectAllowed } from "../billing-redirect";

describe("billingRedirectAllowed", () => {
  it("allows the exact okou.ai production origin", () => {
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockOptionalEnv("ONBOARDING_URL", undefined);

    expect(
      billingRedirectAllowed("https://okou.ai/settings/billing"),
    ).toBeTruthy();
  });

  it("does not allow okou.ai subdomains", () => {
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockOptionalEnv("ONBOARDING_URL", undefined);

    expect(
      billingRedirectAllowed("https://preview.okou.ai/settings/billing"),
    ).toBeFalsy();
  });

  it("does not allow noncanonical okou.ai origins", () => {
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockOptionalEnv("ONBOARDING_URL", undefined);

    expect(
      billingRedirectAllowed("http://okou.ai/settings/billing"),
    ).toBeFalsy();
    expect(
      billingRedirectAllowed("https://okou.ai:8443/settings/billing"),
    ).toBeFalsy();
  });
});
