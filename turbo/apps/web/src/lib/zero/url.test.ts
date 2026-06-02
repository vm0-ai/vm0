import { describe, expect, it, vi } from "vitest";
import { reloadEnv } from "../../env";
import { getAllowedRedirectOrigins } from "./url";

// NEXT_PUBLIC_APP_URL is stubbed to http://localhost:3001 in the test setup.
// Each case stubs NEXT_PUBLIC_PAID_ONBOARDING_URL and reloads the env cache;
// unstubEnvs + the setup beforeEach restore defaults between tests.
describe("getAllowedRedirectOrigins", () => {
  it("appends the *.vm6.ai wildcard for a staging preview onboarding origin", () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://pr-1234-so.vm6.ai");
    reloadEnv();
    expect(getAllowedRedirectOrigins()).toEqual([
      "http://localhost:3001",
      "https://pr-1234-so.vm6.ai",
      "https://*.vm6.ai",
    ]);
  });

  it("keeps the exact origin with no wildcard for production so.vm0.ai", () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://so.vm0.ai");
    reloadEnv();
    expect(getAllowedRedirectOrigins()).toEqual([
      "http://localhost:3001",
      "https://so.vm0.ai",
    ]);
  });

  it("appends the *.vm6.ai wildcard for a staging app origin without paid onboarding env", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pr-15762-app.vm6.ai");
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", undefined);
    reloadEnv();
    expect(getAllowedRedirectOrigins()).toEqual([
      "https://pr-15762-app.vm6.ai",
      "https://*.vm6.ai",
    ]);
  });

  it("returns the app URL only when no paid-onboarding origin is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", undefined);
    reloadEnv();
    expect(getAllowedRedirectOrigins()).toEqual(["http://localhost:3001"]);
  });
});
