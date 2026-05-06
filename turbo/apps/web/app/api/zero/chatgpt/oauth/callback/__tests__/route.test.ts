import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse } from "msw";
import { GET } from "../route";
import { GET as listModelProvidersRoute } from "../../../../model-providers/route";
import {
  createTestRequest,
  findTestModelProviderTokenState,
  ORG_SENTINEL_USER_ID,
  setTestModelProviderNeedsReconnect,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { server } from "../../../../../../../src/mocks/server";
import { http } from "../../../../../../../src/__tests__/msw";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";

interface ListedProvider {
  type: string;
  authMethod: string | null;
  secretNames: string[] | null;
}

async function listOrgProviders(): Promise<ListedProvider[]> {
  const request = createTestRequest(
    "http://localhost:3000/api/zero/model-providers",
  );
  const response = await listModelProvidersRoute(request);
  const data = (await response.json()) as { modelProviders: ListedProvider[] };
  return data.modelProviders;
}

vi.mock("@vm0/core/feature-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vm0/core/feature-switch")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { isFeatureEnabled } = await import("@vm0/core/feature-switch");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_BASE = "http://localhost:3000/api/zero/chatgpt/oauth/callback";

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
  return `${header}.${body}.fake-sig`;
}

function makeIdToken(
  opts: {
    accountId?: string;
    planType?: string;
    workspaceName?: string;
  } = {},
): string {
  return makeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: opts.accountId ?? "acct_test",
      chatgpt_plan_type: opts.planType ?? "plus",
      chatgpt_workspace_name: opts.workspaceName ?? "Test Workspace",
    },
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

function makeState(orgId: string, vm0UserId: string): string {
  return JSON.stringify({ orgId, vm0UserId, flow: "connect" });
}

function makeCallbackRequest(opts: {
  code?: string;
  state?: string;
  stateCookie?: string;
  pkceCookie?: string;
  error?: string;
}): Request {
  const url = new URL(CALLBACK_BASE);
  if (opts.code) url.searchParams.set("code", opts.code);
  if (opts.state) url.searchParams.set("state", opts.state);
  if (opts.error) url.searchParams.set("error", opts.error);
  const cookies: string[] = [];
  if (opts.stateCookie) {
    cookies.push(`chatgpt_oauth_state=${opts.stateCookie}`);
  }
  if (opts.pkceCookie) {
    cookies.push(`chatgpt_oauth_pkce=${opts.pkceCookie}`);
  }
  const headers: Record<string, string> = {};
  if (cookies.length) headers["Cookie"] = cookies.join("; ");
  return new Request(url.toString(), { headers });
}

function clearedCookieNames(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .filter((c) => {
      return c.includes("Max-Age=0");
    })
    .map((c) => {
      return c.split("=")[0] ?? "";
    });
}

describe("GET /api/zero/chatgpt/oauth/callback", () => {
  let user: UserContext;
  let stateValue: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    context.setupMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    user = await context.setupUser();
    stateValue = makeState(user.orgId, user.userId);
  });

  it("happy path persists provider and redirects with success", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          id_token: makeIdToken(),
          access_token: "at_xxx",
          refresh_token: "rt_xxx",
          expires_in: 3600,
        });
      }).handler,
    );

    const request = makeCallbackRequest({
      code: "auth-code-xyz",
      state: stateValue,
      stateCookie: stateValue,
      pkceCookie: "verifier-xyz",
    });
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/settings/model-providers");
    expect(location).toContain("connected=chatgpt");

    const providers = await listOrgProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.type).toBe("codex-oauth-token");
    expect(providers[0]?.authMethod).toBe("oauth");
  });

  it("persists tokenExpiresAt + workspaceName + planType from the OAuth result (#11932)", async () => {
    const before = Date.now();
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          id_token: makeIdToken({
            workspaceName: "Acme Inc",
            planType: "business",
          }),
          access_token: "at_xxx",
          refresh_token: "rt_xxx",
          expires_in: 3600,
        });
      }).handler,
    );

    const request = makeCallbackRequest({
      code: "auth-code-meta",
      state: stateValue,
      stateCookie: stateValue,
      pkceCookie: "verifier-meta",
    });
    await GET(request);

    const state = await findTestModelProviderTokenState(
      user.orgId,
      ORG_SENTINEL_USER_ID,
      "codex-oauth-token",
    );
    expect(state).not.toBeNull();
    expect(state!.workspaceName).toBe("Acme Inc");
    expect(state!.planType).toBe("business");
    // tokenExpiresAt should be ~now + 3600s; allow generous slack for test latency
    const expiresMs = state!.tokenExpiresAt!.getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 3500_000);
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + 3700_000);
  });

  it("re-OAuth clears needsReconnect + lastRefreshErrorCode atomically (#11932)", async () => {
    // Seed an existing stale provider
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          id_token: makeIdToken(),
          access_token: "old_at",
          refresh_token: "old_rt",
          expires_in: 3600,
        });
      }).handler,
    );
    await GET(
      makeCallbackRequest({
        code: "first",
        state: stateValue,
        stateCookie: stateValue,
        pkceCookie: "v1",
      }),
    );
    await setTestModelProviderNeedsReconnect(
      user.orgId,
      ORG_SENTINEL_USER_ID,
      "codex-oauth-token",
      true,
      "refresh_token_expired",
    );

    // Second OAuth — recovery path
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          id_token: makeIdToken(),
          access_token: "new_at",
          refresh_token: "new_rt",
          expires_in: 3600,
        });
      }).handler,
    );
    await GET(
      makeCallbackRequest({
        code: "second",
        state: stateValue,
        stateCookie: stateValue,
        pkceCookie: "v2",
      }),
    );

    const state = await findTestModelProviderTokenState(
      user.orgId,
      ORG_SENTINEL_USER_ID,
      "codex-oauth-token",
    );
    expect(state!.needsReconnect).toBe(false);
    expect(state!.lastRefreshErrorCode).toBeNull();
  });

  it("persists all four secrets including serverOnly fields", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          id_token: makeIdToken(),
          access_token: "at_xxx",
          refresh_token: "rt_xxx",
          expires_in: 3600,
        });
      }).handler,
    );

    const request = makeCallbackRequest({
      code: "code1",
      state: stateValue,
      stateCookie: stateValue,
      pkceCookie: "verifier1",
    });
    await GET(request);

    const providers = await listOrgProviders();
    const secretNames = providers[0]?.secretNames ?? [];
    expect(secretNames).toContain("CHATGPT_ACCESS_TOKEN");
    expect(secretNames).toContain("CHATGPT_REFRESH_TOKEN");
    expect(secretNames).toContain("CHATGPT_ACCOUNT_ID");
    expect(secretNames).toContain("CHATGPT_ID_TOKEN");
  });

  it("rejects free plan with error redirect and no DB row", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          id_token: makeIdToken({ planType: "free" }),
          access_token: "at_xxx",
          refresh_token: "rt_xxx",
        });
      }).handler,
    );

    const request = makeCallbackRequest({
      code: "code-free",
      state: stateValue,
      stateCookie: stateValue,
      pkceCookie: "verifier-free",
    });
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("error=free_plan");

    const providers = await listOrgProviders();
    expect(providers).toHaveLength(0);
  });

  it("returns error when state cookie is missing", async () => {
    const request = makeCallbackRequest({
      code: "c",
      state: stateValue,
      pkceCookie: "v",
    });
    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("error=state_mismatch");
  });

  it("returns error when state param doesn't match cookie", async () => {
    const request = makeCallbackRequest({
      code: "c",
      state: stateValue,
      stateCookie: "different-state-value",
      pkceCookie: "v",
    });
    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("error=state_mismatch");
  });

  it("returns error when PKCE cookie is missing", async () => {
    const request = makeCallbackRequest({
      code: "c",
      state: stateValue,
      stateCookie: stateValue,
    });
    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("error=expired");
  });

  it("forwards OAuth provider error in the redirect", async () => {
    const request = makeCallbackRequest({
      error: "access_denied",
      stateCookie: stateValue,
      pkceCookie: "v",
    });
    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("error=access_denied");
  });

  it("returns exchange_failed on token endpoint 5xx", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return new HttpResponse("internal", { status: 500 });
      }).handler,
    );

    const request = makeCallbackRequest({
      code: "c",
      state: stateValue,
      stateCookie: stateValue,
      pkceCookie: "v",
    });
    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("error=exchange_failed");

    const providers = await listOrgProviders();
    expect(providers).toHaveLength(0);
  });

  it("returns ineligible when feature switch is off mid-flow", async () => {
    mockIsFeatureEnabled.mockReturnValue(false);

    const request = makeCallbackRequest({
      code: "c",
      state: stateValue,
      stateCookie: stateValue,
      pkceCookie: "v",
    });
    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("error=ineligible");

    const providers = await listOrgProviders();
    expect(providers).toHaveLength(0);
  });

  it("returns unauthenticated when caller has no session", async () => {
    mockClerk({ userId: null });

    const request = makeCallbackRequest({
      code: "c",
      state: stateValue,
      stateCookie: stateValue,
      pkceCookie: "v",
    });
    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("error=unauthenticated");

    // Re-auth as the original user to verify nothing was persisted
    mockClerk({ userId: user.userId });
    const providers = await listOrgProviders();
    expect(providers).toHaveLength(0);
  });

  it("rejects state cookie bound to a different org than the auth context", async () => {
    // Forged state cookie carrying another org's id
    const forgedState = makeState("attacker-org-id", user.userId);

    const request = makeCallbackRequest({
      code: "c",
      state: forgedState,
      stateCookie: forgedState,
      pkceCookie: "v",
    });
    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("error=state_mismatch");

    const providers = await listOrgProviders();
    expect(providers).toHaveLength(0);
  });

  it("rejects state cookie bound to a different user than the auth context", async () => {
    // Forged state cookie carrying the right org but a different vm0UserId
    const forgedState = makeState(user.orgId, "attacker-user-id");

    const request = makeCallbackRequest({
      code: "c",
      state: forgedState,
      stateCookie: forgedState,
      pkceCookie: "v",
    });
    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("error=state_mismatch");

    const providers = await listOrgProviders();
    expect(providers).toHaveLength(0);
  });

  it("clears state and PKCE cookies on every branch", async () => {
    // Error branch (no exchange) clears cookies
    const errResp = await GET(
      makeCallbackRequest({
        error: "access_denied",
        stateCookie: stateValue,
        pkceCookie: "v",
      }),
    );
    const errCleared = clearedCookieNames(errResp);
    expect(errCleared).toContain("chatgpt_oauth_state");
    expect(errCleared).toContain("chatgpt_oauth_pkce");

    // Happy path also clears cookies
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          id_token: makeIdToken(),
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
        });
      }).handler,
    );
    const okResp = await GET(
      makeCallbackRequest({
        code: "c",
        state: stateValue,
        stateCookie: stateValue,
        pkceCookie: "v",
      }),
    );
    const okCleared = clearedCookieNames(okResp);
    expect(okCleared).toContain("chatgpt_oauth_state");
    expect(okCleared).toContain("chatgpt_oauth_pkce");
  });
});
