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

describe("Zero configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses ZERO_TOKEN as the sole authentication source", async () => {
    vi.stubEnv("ZERO_TOKEN", "zero-token-value");
    vi.stubEnv("VM0_TOKEN", "legacy-token-value");

    await expect(getToken()).resolves.toBe("zero-token-value");
    await expect(getActiveToken()).resolves.toBe("zero-token-value");
  });

  it("does not fall back to VM0_TOKEN", async () => {
    vi.stubEnv("VM0_TOKEN", "legacy-token-value");

    await expect(getToken()).resolves.toBeUndefined();
    await expect(getActiveToken()).resolves.toBeUndefined();
  });

  it("reads the active organization from a run-scoped ZERO_TOKEN", async () => {
    vi.stubEnv(
      "ZERO_TOKEN",
      buildFakeZeroJwt({
        scope: "zero",
        orgId: "org-from-zero-token",
        capabilities: [],
      }),
    );

    await expect(getActiveOrg()).resolves.toBe("org-from-zero-token");
  });

  it("does not derive an organization from a CLI PAT", async () => {
    vi.stubEnv("ZERO_TOKEN", "vm0_pat_header.payload.signature");

    await expect(getActiveOrg()).resolves.toBeUndefined();
  });

  it("uses VM0_API_BACKEND_URL for routing", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "preview.vm0.ai");

    await expect(getApiUrl()).resolves.toBe("https://preview.vm0.ai");
  });

  it("defaults routing to the production API", async () => {
    await expect(getApiUrl()).resolves.toBe("https://api.vm0.ai");
  });
});
