import { beforeEach, describe, expect, it } from "vitest";

import { billingRedirectAllowed } from "../billing-redirect";
import { mockEnv } from "../env";

describe("billingRedirectAllowed", () => {
  beforeEach(() => {
    mockEnv("APP_URL", "https://app.vm7.ai:8443");
    mockEnv("ENV", "preview");
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

  it("accepts a standalone okou app Worker preview", () => {
    expect(
      billingRedirectAllowed(
        "https://pr-22085-app-okou-app-preview.vm0.workers.dev/onboarding?billing=success",
      ),
    ).toBeTruthy();
  });

  it("rejects a same-named app Worker preview from another account", () => {
    expect(
      billingRedirectAllowed(
        "https://pr-22085-app-okou-app-preview.attacker.workers.dev/onboarding?billing=success",
      ),
    ).toBeFalsy();
  });

  it("rejects a standalone okou app Worker preview in production", () => {
    mockEnv("ENV", "production");

    expect(
      billingRedirectAllowed(
        "https://pr-22085-app-okou-app-preview.vm0.workers.dev/onboarding?billing=success",
      ),
    ).toBeFalsy();
  });
});
