import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getActiveOrg,
  getActiveToken,
  getApiUrl,
  getCliPublicBrand,
  getToken,
} from "../config";

function buildFakeZeroJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = Buffer.from("fake-signature").toString("base64url");
  return `vm0_sandbox_${header}.${body}.${signature}`;
}

describe("Okou configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses OKOU_TOKEN as the run authentication source", async () => {
    vi.stubEnv("OKOU_TOKEN", "okou-token-value");
    vi.stubEnv("VM0_TOKEN", "legacy-token-value");

    await expect(getToken()).resolves.toBe("okou-token-value");
    await expect(getActiveToken()).resolves.toBe("okou-token-value");
  });

  it("ignores ZERO_TOKEN when OKOU_TOKEN is present", async () => {
    vi.stubEnv("OKOU_TOKEN", "okou-token-value");
    vi.stubEnv("ZERO_TOKEN", "zero-token-value");

    await expect(getToken()).resolves.toBe("okou-token-value");
    await expect(getActiveToken()).resolves.toBe("okou-token-value");
  });

  it("does not fall back to ZERO_TOKEN when OKOU_TOKEN is empty", async () => {
    vi.stubEnv("OKOU_TOKEN", "");
    vi.stubEnv("ZERO_TOKEN", "zero-token-value");

    await expect(getToken()).resolves.toBeUndefined();
    await expect(getActiveToken()).resolves.toBeUndefined();
  });

  it("does not fall back to VM0_TOKEN", async () => {
    vi.stubEnv("VM0_TOKEN", "legacy-token-value");

    await expect(getToken()).resolves.toBeUndefined();
    await expect(getActiveToken()).resolves.toBeUndefined();
  });

  it("rejects a zero-scoped OKOU_TOKEN", async () => {
    vi.stubEnv(
      "OKOU_TOKEN",
      buildFakeZeroJwt({
        scope: "zero",
        orgId: "org-from-zero-token",
        capabilities: [],
      }),
    );

    await expect(getActiveOrg()).resolves.toBeUndefined();
  });

  it("reads the active organization from an okou-scoped OKOU_TOKEN", async () => {
    vi.stubEnv(
      "OKOU_TOKEN",
      buildFakeZeroJwt({
        scope: "okou",
        orgId: "org-from-okou-token",
        capabilities: [],
      }),
    );

    await expect(getActiveOrg()).resolves.toBe("org-from-okou-token");
  });

  it("does not derive an organization from a CLI PAT", async () => {
    vi.stubEnv("OKOU_TOKEN", "vm0_pat_header.payload.signature");

    await expect(getActiveOrg()).resolves.toBeUndefined();
  });

  it("adds https to a canonical API URL without a protocol", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "canonical.example.test");

    await expect(getApiUrl()).resolves.toBe("https://canonical.example.test");
  });

  it.each([
    "http://canonical.example.test/",
    "https://canonical.example.test/",
  ])("preserves the configured API URL %s", async (canonicalUrl) => {
    vi.stubEnv("OKOU_API_BACKEND_URL", canonicalUrl);

    await expect(getApiUrl()).resolves.toBe(canonicalUrl);
  });

  it.each([undefined, ""])(
    "defaults routing to the production API when the canonical URL is %s",
    async (canonicalUrl) => {
      vi.stubEnv("OKOU_API_BACKEND_URL", canonicalUrl);

      await expect(getApiUrl()).resolves.toBe("https://api.okou.ai");
    },
  );

  it("prefers the run-token public brand over the configured API URL", () => {
    vi.stubEnv(
      "OKOU_TOKEN",
      buildFakeZeroJwt({
        scope: "okou",
        capabilities: [],
        publicBrand: "okou",
      }),
    );
    vi.stubEnv("OKOU_API_BACKEND_URL", "https://api.vm0.ai");

    expect(getCliPublicBrand()).toBe("okou");
  });

  it.each([
    ["api.vm0.ai", "vm0"],
    ["https://api.okou.ai", "okou"],
  ] as const)(
    "selects the %s API URL brand as %s",
    (canonicalUrl, expectedBrand) => {
      vi.stubEnv("OKOU_API_BACKEND_URL", canonicalUrl);

      expect(getCliPublicBrand()).toBe(expectedBrand);
    },
  );

  it.each([undefined, ""])(
    "defaults the public brand to Okou when the canonical URL is %s",
    (canonicalUrl) => {
      vi.stubEnv("OKOU_API_BACKEND_URL", canonicalUrl);

      expect(getCliPublicBrand()).toBe("okou");
    },
  );
});
