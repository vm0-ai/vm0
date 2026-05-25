import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { getModelProviderOAuthSecretMetadata } from "../../../model-provider-auth";
import {
  getChatgptSecretName,
  getChatgptRefreshSecretName,
  isChatgptRefreshError,
  refreshChatgptToken,
  type ChatgptRefreshError,
} from "../codex-oauth";
import { codexOauthProvider } from "../codex-oauth-provider";
import { server } from "./test-server";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_PUBLIC_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

function getCodexRefreshAccess() {
  const access = codexOauthProvider.access;
  if (access.kind !== "refresh-token") {
    throw new Error("codexOauthProvider must expose refresh-token access");
  }
  return access;
}

describe("connector/providers/codex-oauth", () => {
  describe("refreshChatgptToken", () => {
    it("refreshes access token and returns rotated refresh token", async () => {
      const handler = http.post(TOKEN_URL, async ({ request }) => {
        expect(request.headers.get("content-type")).toBe("application/json");
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.client_id).toBe(CODEX_PUBLIC_CLIENT_ID);
        expect(body.grant_type).toBe("refresh_token");
        expect(body.refresh_token).toBe("old-rt");
        return HttpResponse.json({
          access_token: "new-at",
          refresh_token: "new-rt",
          expires_in: 600000,
        });
      });
      server.use(handler);

      const result = await refreshChatgptToken("x", "x", "old-rt");
      expect(result.accessToken).toBe("new-at");
      expect(result.refreshToken).toBe("new-rt");
      expect(result.expiresIn).toBe(600000);
    });

    it("returns null refresh token when response omits it", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json({ access_token: "new-at" });
      });
      server.use(handler);

      const result = await refreshChatgptToken("x", "x", "old-rt");
      expect(result.accessToken).toBe("new-at");
      expect(result.refreshToken).toBeNull();
    });

    it("classifies refresh_token_expired into ChatgptRefreshError", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json(
          {
            error: {
              code: "refresh_token_expired",
              message: "token expired",
            },
          },
          { status: 401 },
        );
      });
      server.use(handler);

      await expect(
        refreshChatgptToken("x", "x", "old-rt"),
      ).rejects.toMatchObject({
        name: "ChatgptRefreshError",
        code: "refresh_token_expired",
      });
    });

    it("classifies refresh_token_reused into ChatgptRefreshError", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json(
          { error: { code: "refresh_token_reused", message: "reused" } },
          { status: 401 },
        );
      });
      server.use(handler);

      await expect(
        refreshChatgptToken("x", "x", "old-rt"),
      ).rejects.toMatchObject({
        name: "ChatgptRefreshError",
        code: "refresh_token_reused",
      });
    });

    it("classifies refresh_token_invalidated into ChatgptRefreshError", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json(
          {
            error: {
              code: "refresh_token_invalidated",
              message: "invalidated",
            },
          },
          { status: 401 },
        );
      });
      server.use(handler);

      const error = await refreshChatgptToken("x", "x", "old-rt").catch(
        (e: unknown) => {
          return e;
        },
      );
      expect(isChatgptRefreshError(error)).toBe(true);
      expect((error as ChatgptRefreshError).code).toBe(
        "refresh_token_invalidated",
      );
    });

    it("classifies unknown 401 codes into refresh_token_other", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json(
          { error: { code: "weird_unrelated_error", message: "huh" } },
          { status: 401 },
        );
      });
      server.use(handler);

      const error = await refreshChatgptToken("x", "x", "old-rt").catch(
        (e: unknown) => {
          return e;
        },
      );
      expect(isChatgptRefreshError(error)).toBe(true);
      expect((error as ChatgptRefreshError).code).toBe("refresh_token_other");
    });

    it("throws non-typed error on 5xx so caller can retry", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return new HttpResponse("Bad Gateway", { status: 502 });
      });
      server.use(handler);

      const error = await refreshChatgptToken("x", "x", "old-rt").catch(
        (e: unknown) => {
          return e;
        },
      );
      expect(error).toBeInstanceOf(Error);
      expect(isChatgptRefreshError(error)).toBe(false);
    });

    it("throws when refresh response is missing access_token", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json({});
      });
      server.use(handler);

      await expect(refreshChatgptToken("x", "x", "old-rt")).rejects.toThrow(
        /No access token in ChatGPT refresh response/,
      );
    });
  });

  describe("codexOauthProvider", () => {
    it("is registered with model-provider refresh metadata", () => {
      expect(
        getModelProviderOAuthSecretMetadata("codex-oauth-token"),
      ).toStrictEqual({
        accessSecretName: "CHATGPT_ACCESS_TOKEN",
        refreshSecretName: "CHATGPT_REFRESH_TOKEN",
        isRefreshable: true,
      });
    });

    it("does not expose browser authorize or code exchange helpers", () => {
      expect(codexOauthProvider.grant.kind).toBe("none");
    });

    it("getClientId returns the Codex public client_id (used by refresh)", () => {
      expect(getCodexRefreshAccess().getClientId({})).toBe(
        CODEX_PUBLIC_CLIENT_ID,
      );
    });

    it("getClientSecret returns undefined (PKCE-only)", () => {
      expect(getCodexRefreshAccess().getClientSecret({})).toBeUndefined();
    });

    it("returns documented secret names", () => {
      expect(getChatgptSecretName()).toBe("CHATGPT_ACCESS_TOKEN");
      expect(getChatgptRefreshSecretName()).toBe("CHATGPT_REFRESH_TOKEN");
    });
  });
});
