import { describe, expect, it, vi } from "vitest";

import {
  checkLimitedFreeRunModelAdmission,
  checkOrgCreditsForRunAdmission,
} from "../zero-run-admission.service";

type AdmissionDb = Parameters<typeof checkOrgCreditsForRunAdmission>[0]["db"];

function dbForAvailability(
  tier: string,
  credits = "1000",
  unsettledExpired = "0",
): AdmissionDb {
  return {
    execute: vi.fn().mockResolvedValue({
      rows: [
        {
          tier,
          credits,
          unsettled_expired: unsettledExpired,
        },
      ],
    }),
  } as unknown as AdmissionDb;
}

describe("checkOrgCreditsForRunAdmission", () => {
  it("rejects limited-free-1 runs that use BYOK providers", async () => {
    const result = await checkOrgCreditsForRunAdmission({
      db: dbForAvailability("limited-free-1"),
      orgId: "org_limited_free_byok",
      modelProviderType: "anthropic-api-key",
      selectedModel: "claude-sonnet-4-6",
    });

    expect(result?.status).toBe(402);
    expect(result?.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("allows limited-free-1 vm0 runs for unrestricted models with credits", async () => {
    const result = await checkOrgCreditsForRunAdmission({
      db: dbForAvailability("limited-free-1"),
      orgId: "org_limited_free_vm0",
      modelProviderType: "vm0",
      selectedModel: "claude-sonnet-4-6",
    });

    expect(result).toBeUndefined();
  });

  it("rejects limited-free-1 vm0 runs for restricted models", async () => {
    const result = await checkOrgCreditsForRunAdmission({
      db: dbForAvailability("limited-free-1"),
      orgId: "org_limited_free_restricted",
      modelProviderType: "vm0",
      selectedModel: "gpt-5.5",
    });

    expect(result?.status).toBe(402);
    expect(result?.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });
});

describe("checkLimitedFreeRunModelAdmission", () => {
  it("rejects prepared limited-free-1 runs without a vm0 provider", async () => {
    const result = await checkLimitedFreeRunModelAdmission({
      db: dbForAvailability("limited-free-1"),
      orgId: "org_limited_free_prepared_byok",
      modelProviderType: null,
      selectedModel: "claude-sonnet-4-6",
    });

    expect(result?.status).toBe(402);
    expect(result?.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });
});
