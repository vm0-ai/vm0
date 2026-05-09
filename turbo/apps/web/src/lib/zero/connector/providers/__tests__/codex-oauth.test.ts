import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { server } from "../../../../../mocks/server";
import { http } from "../../../../../__tests__/msw";
import { testContext } from "../../../../../__tests__/test-helpers";
import { PROVIDER_HANDLERS } from "../../provider-registry";
import {
  exchangeChatgptCode,
  refreshChatgptToken,
  getChatgptSecretName,
  getChatgptRefreshSecretName,
  isChatgptRefreshError,
  type ChatgptRefreshError,
} from "../codex-oauth";
import { codexOauthHandler } from "../codex-oauth-handler";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_PUBLIC_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const context = testContext();

function base64Url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function createJwt(payload: Record<string, unknown>): string {
  return [
    base64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
    base64Url(JSON.stringify(payload)),
    "",
  ].join(".");
}

describe("connector/providers/codex-oauth", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("exchangeChatgptCode", () => {
    it("exchanges authorization code and parses ChatGPT claims", async () => {
      const accessToken = createJwt({ exp: 1_900_000_000 });
      const idToken = createJwt({
        sub: "user-1",
        email: "user@example.com",
        name: "Test User",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "account-1",
          chatgpt_plan_type: "plus",
          workspace: { name: "Personal" },
        },
      });
      const { handler } = http.post(TOKEN_URL, async ({ request }) => {
        expect(request.headers.get("content-type")).toBe("application/json");
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.client_id).toBe(CODEX_PUBLIC_CLIENT_ID);
        expect(body.grant_type).toBe("authorization_code");
        expect(body.code).toBe("code-1");
        expect(body.redirect_uri).toBe("https://app.example/callback");
        expect(body.code_verifier).toBe("verifier-1");
        return HttpResponse.json({
          access_token: accessToken,
          refresh_token: "refresh-1",
          id_token: idToken,
          expires_in: 3600,
        });
      });
      server.use(handler);

      const result = await exchangeChatgptCode(
        CODEX_PUBLIC_CLIENT_ID,
        "code-1",
        "https://app.example/callback",
        "verifier-1",
      );

      expect(result.accessToken).toBe(accessToken);
      expect(result.refreshToken).toBe("refresh-1");
      expect(result.accountId).toBe("account-1");
      expect(result.workspaceName).toBe("Personal");
      expect(result.planType).toBe("plus");
      expect(result.userInfo).toEqual({
        id: "account-1",
        username: "Test User",
        email: "user@example.com",
      });
    });

    it("rejects free ChatGPT plans", async () => {
      const { handler } = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: createJwt({ exp: 1_900_000_000 }),
          refresh_token: "refresh-1",
          id_token: createJwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "account-1",
              chatgpt_plan_type: "free",
            },
          }),
        });
      });
      server.use(handler);

      await expect(
        exchangeChatgptCode(
          CODEX_PUBLIC_CLIENT_ID,
          "code-1",
          "https://app.example/callback",
          "verifier-1",
        ),
      ).rejects.toThrow(/free plan is not supported/);
    });
  });

  describe("refreshChatgptToken", () => {
    it("refreshes access token and returns rotated refresh token", async () => {
      const { handler } = http.post(TOKEN_URL, async ({ request }) => {
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
      const { handler } = http.post(TOKEN_URL, () => {
        return HttpResponse.json({ access_token: "new-at" });
      });
      server.use(handler);

      const result = await refreshChatgptToken("x", "x", "old-rt");
      expect(result.accessToken).toBe("new-at");
      expect(result.refreshToken).toBeNull();
    });

    it("classifies refresh_token_expired into ChatgptRefreshError", async () => {
      const { handler } = http.post(TOKEN_URL, () => {
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
      const { handler } = http.post(TOKEN_URL, () => {
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
      const { handler } = http.post(TOKEN_URL, () => {
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
      const { handler } = http.post(TOKEN_URL, () => {
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
      const { handler } = http.post(TOKEN_URL, () => {
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
      const { handler } = http.post(TOKEN_URL, () => {
        return HttpResponse.json({});
      });
      server.use(handler);

      await expect(refreshChatgptToken("x", "x", "old-rt")).rejects.toThrow(
        /No access token in ChatGPT refresh response/,
      );
    });
  });

  describe("codexOauthHandler", () => {
    it("is registered in PROVIDER_HANDLERS under codex-oauth key", () => {
      expect(PROVIDER_HANDLERS["codex-oauth"]).toBe(codexOauthHandler);
    });

    it("buildAuthUrl returns OpenAI OAuth authorization URL with PKCE", async () => {
      const result = await codexOauthHandler.buildAuthUrl(
        CODEX_PUBLIC_CLIENT_ID,
        "https://app.example/callback",
        "state-1",
      );

      expect(result).not.toBeTypeOf("string");
      if (typeof result === "string") {
        throw new Error("Expected PKCE authorization result");
      }
      const url = new URL(result.url);
      expect(url.origin).toBe("https://auth.openai.com");
      expect(url.pathname).toBe("/oauth/authorize");
      expect(url.searchParams.get("client_id")).toBe(CODEX_PUBLIC_CLIENT_ID);
      expect(url.searchParams.get("redirect_uri")).toBe(
        "https://app.example/callback",
      );
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("state")).toBe("state-1");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(result.codeVerifier.length).toBeGreaterThan(20);
    });

    it("exchangeCode requires a PKCE verifier", async () => {
      await expect(
        codexOauthHandler.exchangeCode("c", "s", "code", "redirect"),
      ).rejects.toThrow(/PKCE/);
    });

    it("revokeToken is not registered", () => {
      expect(codexOauthHandler.revokeToken).toBeUndefined();
    });

    it("getClientId returns the Codex public client_id (used by refresh)", () => {
      const env = {} as Parameters<typeof codexOauthHandler.getClientId>[0];
      expect(codexOauthHandler.getClientId(env)).toBe(CODEX_PUBLIC_CLIENT_ID);
    });

    it("getClientSecret returns undefined (PKCE-only)", () => {
      const env = {} as Parameters<typeof codexOauthHandler.getClientSecret>[0];
      expect(codexOauthHandler.getClientSecret(env)).toBeUndefined();
    });

    it("returns documented secret names", () => {
      expect(getChatgptSecretName()).toBe("CHATGPT_ACCESS_TOKEN");
      expect(getChatgptRefreshSecretName()).toBe("CHATGPT_REFRESH_TOKEN");
    });
  });
});
