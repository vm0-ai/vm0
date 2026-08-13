import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveOrg, getActiveToken, getApiUrl, getToken } from "../config";

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

  it("prefers OKOU_API_BACKEND_URL when both backend names are set", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "canonical.example.test");
    vi.stubEnv("VM0_API_BACKEND_URL", "https://legacy.example.test");

    await expect(getApiUrl()).resolves.toBe("https://canonical.example.test");
  });

  it.each([undefined, ""])(
    "uses VM0_API_BACKEND_URL when OKOU_API_BACKEND_URL is %s",
    async (canonicalUrl) => {
      vi.stubEnv("OKOU_API_BACKEND_URL", canonicalUrl);
      vi.stubEnv("VM0_API_BACKEND_URL", "preview.vm0.ai");

      await expect(getApiUrl()).resolves.toBe("https://preview.vm0.ai");
    },
  );

  it("preserves configured protocols and trailing slashes", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://canonical.example.test/");

    await expect(getApiUrl()).resolves.toBe("http://canonical.example.test/");
  });

  it("uses VM0_API_BACKEND_URL for routing", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "preview.vm0.ai");

    await expect(getApiUrl()).resolves.toBe("https://preview.vm0.ai");
  });

  it("defaults routing to the production API", async () => {
    await expect(getApiUrl()).resolves.toBe("https://api.okou.ai");
  });
});
