import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET as userinfoGet } from "../userinfo/route";
import { reloadEnv } from "../../../../../src/env";
import { mintAccessToken, mintExpiredAccessToken } from "../_lib/token-helpers";

const APP_URL = "http://localhost:3000";

describe("/api/test/oauth-provider", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", "");
    reloadEnv();
  });

  describe("production guard", () => {
    it("userinfo returns 404 in production", async () => {
      vi.stubEnv("VERCEL_ENV", "production");
      reloadEnv();
      const response = await userinfoGet(
        new Request(`${APP_URL}/api/test/oauth-provider/userinfo`),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("userinfo", () => {
    it("returns user payload with valid Bearer token", async () => {
      const token = mintAccessToken(3600);
      const response = await userinfoGet(
        new Request(`${APP_URL}/api/test/oauth-provider/userinfo`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.id).toBe("testoauth-user-1");
    });

    it("returns 401 without Bearer token", async () => {
      const response = await userinfoGet(
        new Request(`${APP_URL}/api/test/oauth-provider/userinfo`),
      );
      expect(response.status).toBe(401);
    });

    it("returns 401 with non-test token", async () => {
      const response = await userinfoGet(
        new Request(`${APP_URL}/api/test/oauth-provider/userinfo`, {
          headers: { authorization: "Bearer not-a-testoauth-token" },
        }),
      );
      expect(response.status).toBe(401);
    });

    it("returns 401 for expired access token", async () => {
      const token = mintExpiredAccessToken();
      const response = await userinfoGet(
        new Request(`${APP_URL}/api/test/oauth-provider/userinfo`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "expired_token" });
    });
  });
});
