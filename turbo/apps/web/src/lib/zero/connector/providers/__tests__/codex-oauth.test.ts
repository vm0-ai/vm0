import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { CONNECTOR_TYPES } from "@vm0/connectors/connectors";
import { server } from "../../../../../mocks/server";
import { http } from "../../../../../__tests__/msw";
import { testContext } from "../../../../../__tests__/test-helpers";
import { PROVIDER_HANDLERS } from "../../provider-registry";
import {
  buildChatgptAuthorizationUrl,
  exchangeChatgptCode,
  refreshChatgptToken,
  revokeChatgptToken,
  getChatgptSecretName,
  getChatgptRefreshSecretName,
  isChatgptRefreshError,
  isChatgptFreePlanError,
  type ChatgptRefreshError,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_ISSUER,
  CHATGPT_OAUTH_SCOPES,
} from "../codex-oauth";
import { codexOauthHandler } from "../codex-oauth-handler";

const TOKEN_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/token`;
const REVOKE_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/revoke`;

const context = testContext();

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

interface IdTokenOpts {
  accountId?: string;
  planType?: string;
  workspaceName?: string;
  workspaceClaim?:
    | "organization.title"
    | "workspace.name"
    | "chatgpt_workspace_name";
  exp?: number;
  omitAuth?: boolean;
}

function makeIdToken(opts: IdTokenOpts = {}): string {
  if (opts.omitAuth) {
    return makeJwt({ exp: opts.exp ?? Math.floor(Date.now() / 1000) + 3600 });
  }
  const auth: Record<string, unknown> = {};
  if (opts.accountId !== undefined) {
    auth.chatgpt_account_id = opts.accountId;
  }
  if (opts.planType !== undefined) {
    auth.chatgpt_plan_type = opts.planType;
  }
  if (opts.workspaceName !== undefined) {
    if (opts.workspaceClaim === "organization.title") {
      auth.organization = { title: opts.workspaceName };
    } else if (opts.workspaceClaim === "workspace.name") {
      auth.workspace = { name: opts.workspaceName };
    } else {
      auth.chatgpt_workspace_name = opts.workspaceName;
    }
  }
  return makeJwt({
    "https://api.openai.com/auth": auth,
    exp: opts.exp ?? Math.floor(Date.now() / 1000) + 3600,
  });
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(new Uint8Array(hash))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("connector/providers/codex-oauth", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("buildChatgptAuthorizationUrl", () => {
    it("builds URL with required PKCE params and scopes", async () => {
      const result = await buildChatgptAuthorizationUrl(
        "ignored-client-id",
        "https://example.com/callback",
        "test-state",
      );

      const url = new URL(result.url);
      expect(url.origin + url.pathname).toBe(
        `${CHATGPT_OAUTH_ISSUER}/oauth/authorize`,
      );
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("client_id")).toBe(CHATGPT_OAUTH_CLIENT_ID);
      expect(url.searchParams.get("redirect_uri")).toBe(
        "https://example.com/callback",
      );
      expect(url.searchParams.get("scope")).toBe(CHATGPT_OAUTH_SCOPES);
      expect(url.searchParams.get("state")).toBe("test-state");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
    });

    it("returns a code_verifier in the base64url charset", async () => {
      const result = await buildChatgptAuthorizationUrl(
        "x",
        "https://example.com/cb",
        "s",
      );
      expect(result.codeVerifier.length).toBeGreaterThanOrEqual(43);
      expect(result.codeVerifier.length).toBeLessThanOrEqual(128);
      expect(result.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("computes the code_challenge as S256 of the returned verifier", async () => {
      const result = await buildChatgptAuthorizationUrl(
        "x",
        "https://example.com/cb",
        "s",
      );
      const url = new URL(result.url);
      const challenge = url.searchParams.get("code_challenge");
      expect(challenge).toBeTruthy();
      expect(challenge).toBe(await sha256Base64Url(result.codeVerifier));
    });
  });

  describe("exchangeChatgptCode", () => {
    it("exchanges code for tokens and decodes id_token claims", async () => {
      const idToken = makeIdToken({
        accountId: "acc-123",
        planType: "plus",
        workspaceName: "Acme Org",
        workspaceClaim: "organization.title",
      });
      const { handler } = http.post(TOKEN_URL, async ({ request }) => {
        const body = await request.text();
        const params = new URLSearchParams(body);
        expect(params.get("grant_type")).toBe("authorization_code");
        expect(params.get("code")).toBe("auth-code");
        expect(params.get("redirect_uri")).toBe("https://example.com/cb");
        expect(params.get("client_id")).toBe(CHATGPT_OAUTH_CLIENT_ID);
        expect(params.get("code_verifier")).toBe("verifier-xyz");
        return HttpResponse.json({
          id_token: idToken,
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 600000,
          scope: CHATGPT_OAUTH_SCOPES,
        });
      });
      server.use(handler);

      const result = await exchangeChatgptCode(
        "ignored",
        "ignored",
        "auth-code",
        "https://example.com/cb",
        "verifier-xyz",
      );

      expect(result.accessToken).toBe("at-1");
      expect(result.refreshToken).toBe("rt-1");
      expect(result.idToken).toBe(idToken);
      expect(result.accountId).toBe("acc-123");
      expect(result.planType).toBe("plus");
      expect(result.workspaceName).toBe("Acme Org");
      expect(result.expiresIn).toBe(600000);
      expect(result.scopes).toEqual(CHATGPT_OAUTH_SCOPES.split(" "));
    });

    it("extracts workspace name from workspace.name claim", async () => {
      const idToken = makeIdToken({
        accountId: "a",
        planType: "pro",
        workspaceName: "Workspace Alpha",
        workspaceClaim: "workspace.name",
      });
      const { handler } = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          id_token: idToken,
          access_token: "at",
          refresh_token: "rt",
        });
      });
      server.use(handler);

      const result = await exchangeChatgptCode(
        "x",
        "x",
        "c",
        "https://example.com/cb",
        "v",
      );
      expect(result.workspaceName).toBe("Workspace Alpha");
    });

    it("extracts workspace name from chatgpt_workspace_name claim as fallback", async () => {
      const idToken = makeIdToken({
        accountId: "a",
        planType: "business",
        workspaceName: "Fallback WS",
        workspaceClaim: "chatgpt_workspace_name",
      });
      const { handler } = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          id_token: idToken,
          access_token: "at",
          refresh_token: "rt",
        });
      });
      server.use(handler);

      const result = await exchangeChatgptCode(
        "x",
        "x",
        "c",
        "https://example.com/cb",
        "v",
      );
      expect(result.workspaceName).toBe("Fallback WS");
    });

    it("returns null workspace name when no workspace claim is present", async () => {
      const idToken = makeIdToken({ accountId: "a", planType: "plus" });
      const { handler } = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          id_token: idToken,
          access_token: "at",
          refresh_token: "rt",
        });
      });
      server.use(handler);

      const result = await exchangeChatgptCode(
        "x",
        "x",
        "c",
        "https://example.com/cb",
        "v",
      );
      expect(result.workspaceName).toBeNull();
    });

    it("rejects free plan_type with typed ChatgptFreePlanError", async () => {
      const idToken = makeIdToken({ accountId: "a", planType: "free" });
      const { handler } = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          id_token: idToken,
          access_token: "at",
          refresh_token: "rt",
        });
      });
      server.use(handler);

      const promise = exchangeChatgptCode(
        "x",
        "x",
        "c",
        "https://example.com/cb",
        "v",
      );
      await expect(promise).rejects.toThrow(/free plan/i);
      await expect(promise).rejects.toSatisfy(isChatgptFreePlanError);
    });

    it("isChatgptFreePlanError type guard rejects unrelated errors", () => {
      expect(isChatgptFreePlanError(new Error("anything else"))).toBe(false);
      expect(isChatgptFreePlanError("not even an error")).toBe(false);
      expect(isChatgptFreePlanError(null)).toBe(false);
      expect(isChatgptFreePlanError(undefined)).toBe(false);
    });

    it("throws when id_token is missing required auth claims", async () => {
      const idToken = makeIdToken({ omitAuth: true });
      const { handler } = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          id_token: idToken,
          access_token: "at",
          refresh_token: "rt",
        });
      });
      server.use(handler);

      await expect(
        exchangeChatgptCode("x", "x", "c", "https://example.com/cb", "v"),
      ).rejects.toThrow(/missing required auth claims/);
    });

    it("throws when token endpoint returns HTTP error", async () => {
      const { handler } = http.post(TOKEN_URL, () => {
        return new HttpResponse("Internal Server Error", { status: 500 });
      });
      server.use(handler);

      await expect(
        exchangeChatgptCode("x", "x", "c", "https://example.com/cb", "v"),
      ).rejects.toThrow(/ChatGPT token exchange failed/);
    });

    it("throws when response is missing tokens", async () => {
      const { handler } = http.post(TOKEN_URL, () => {
        return HttpResponse.json({});
      });
      server.use(handler);

      await expect(
        exchangeChatgptCode("x", "x", "c", "https://example.com/cb", "v"),
      ).rejects.toThrow(/missing tokens/);
    });
  });

  describe("refreshChatgptToken", () => {
    it("refreshes access token and returns rotated refresh token", async () => {
      const { handler } = http.post(TOKEN_URL, async ({ request }) => {
        expect(request.headers.get("content-type")).toBe("application/json");
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.client_id).toBe(CHATGPT_OAUTH_CLIENT_ID);
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

  describe("revokeChatgptToken", () => {
    it("posts to revoke endpoint and resolves on 200", async () => {
      const { handler } = http.post(REVOKE_URL, async ({ request }) => {
        const body = await request.text();
        const params = new URLSearchParams(body);
        expect(params.get("token")).toBe("at-to-revoke");
        return new HttpResponse(null, { status: 200 });
      });
      server.use(handler);

      await expect(
        revokeChatgptToken("x", "x", "at-to-revoke"),
      ).resolves.toBeUndefined();
    });

    it("throws on non-2xx status", async () => {
      const { handler } = http.post(REVOKE_URL, () => {
        return new HttpResponse("forbidden", { status: 403 });
      });
      server.use(handler);

      await expect(revokeChatgptToken("x", "x", "at")).rejects.toThrow(
        /ChatGPT token revoke failed/,
      );
    });
  });

  describe("codexOauthHandler", () => {
    it("is registered in PROVIDER_HANDLERS under codex-oauth key", () => {
      expect(PROVIDER_HANDLERS["codex-oauth"]).toBe(codexOauthHandler);
    });

    it("getClientId returns the hardcoded Codex public client_id", () => {
      const env = {} as Parameters<typeof codexOauthHandler.getClientId>[0];
      expect(codexOauthHandler.getClientId(env)).toBe(CHATGPT_OAUTH_CLIENT_ID);
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

  describe("registry/implementation drift guard", () => {
    it("connector entry oauth URLs match the implementation constants", () => {
      const connector = CONNECTOR_TYPES["codex-oauth"];
      expect(connector.oauth?.authorizationUrl).toBe(
        `${CHATGPT_OAUTH_ISSUER}/oauth/authorize`,
      );
      expect(connector.oauth?.tokenUrl).toBe(
        `${CHATGPT_OAUTH_ISSUER}/oauth/token`,
      );
      expect(connector.oauth?.scopes.join(" ")).toBe(CHATGPT_OAUTH_SCOPES);
    });

    it("connector oauth entry exposes only authorizationUrl/tokenUrl/scopes (PKCE-only, no clientId)", () => {
      // Wave 2's refresh pipeline reads client identity through the handler,
      // not the registry — assert structurally that the registry oauth entry
      // does not leak a `clientId` (or any unexpected key) so the PKCE-only
      // boundary stays explicit.
      const oauth = CONNECTOR_TYPES["codex-oauth"].oauth;
      expect(oauth).toBeDefined();
      expect(Object.keys(oauth ?? {}).sort()).toEqual([
        "authorizationUrl",
        "scopes",
        "tokenUrl",
      ]);
    });

    it("handler client identity matches the implementation constant (PKCE-only)", () => {
      // Pair check: registry has no clientId, handler resolves to the
      // canonical Codex public client_id, and getClientSecret stays undefined.
      const env = {} as Parameters<typeof codexOauthHandler.getClientId>[0];
      expect(codexOauthHandler.getClientId(env)).toBe(CHATGPT_OAUTH_CLIENT_ID);
      expect(codexOauthHandler.getClientSecret(env)).toBeUndefined();
    });
  });
});
