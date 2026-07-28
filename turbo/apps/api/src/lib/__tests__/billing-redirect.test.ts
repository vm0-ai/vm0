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

  it("accepts an immutable okou Pages deployment in preview", () => {
    expect(
      billingRedirectAllowed(
        "https://3508a2f5.okou-app.pages.dev/onboarding?billing=success",
      ),
    ).toBeTruthy();
  });

  it("rejects an immutable okou Pages deployment in production", () => {
    mockEnv("ENV", "production");

    expect(
      billingRedirectAllowed(
        "https://3508a2f5.okou-app.pages.dev/onboarding?billing=success",
      ),
    ).toBeFalsy();
  });
});
