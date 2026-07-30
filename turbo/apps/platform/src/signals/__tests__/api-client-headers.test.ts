import { describe, expect, it } from "vitest";
import { HttpResponse } from "msw";
import {
  addClientCapabilityToVersion,
  CLIENT_CAPABILITY_ES_ES_LOCALE,
  CLIENT_CAPABILITY_IT_IT_LOCALE,
  CLIENT_CAPABILITY_JA_JP_LOCALE,
  CLIENT_CAPABILITY_KO_KR_LOCALE,
  CLIENT_CAPABILITY_ID_ID_LOCALE,
  CLIENT_CAPABILITY_DE_DE_LOCALE,
  CLIENT_CAPABILITY_PT_BR_LOCALE,
  CLIENT_FORCE_UPGRADE_STATUS,
} from "@vm0/api-contracts/contracts/client-headers";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";

import {
  clearMockedAuth,
  mockedClerk,
  mockUser,
} from "../../__tests__/mock-auth.ts";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { fetch$ } from "../fetch.ts";
import {
  forceUpgradeDialogOpen$,
  listenForceUpgradeDialog$,
} from "../force-upgrade.ts";
import { setRootSignal$ } from "../root-signal.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EXPECTED_CLIENT_VERSION = addClientCapabilityToVersion(
  addClientCapabilityToVersion(
    addClientCapabilityToVersion(
      addClientCapabilityToVersion(
        addClientCapabilityToVersion(
          addClientCapabilityToVersion(
            addClientCapabilityToVersion(
              "0.540.0",
              CLIENT_CAPABILITY_PT_BR_LOCALE,
            ),
            CLIENT_CAPABILITY_JA_JP_LOCALE,
          ),
          CLIENT_CAPABILITY_KO_KR_LOCALE,
        ),
        CLIENT_CAPABILITY_ID_ID_LOCALE,
      ),
      CLIENT_CAPABILITY_DE_DE_LOCALE,
    ),
    CLIENT_CAPABILITY_ES_ES_LOCALE,
  ),
  CLIENT_CAPABILITY_IT_IT_LOCALE,
);

interface ObservedClientHeaders {
  readonly requestId: string | null;
  readonly sessionId: string | null;
  readonly type: string | null;
  readonly version: string | null;
  readonly zeroMailVersion: string | null;
}

function observedClientHeaders(request: Request): ObservedClientHeaders {
  return {
    requestId: request.headers.get("x-client-request-id"),
    sessionId: request.headers.get("x-client-session-id"),
    type: request.headers.get("x-client-type"),
    version: request.headers.get("x-client-version"),
    zeroMailVersion: request.headers.get("x-zero-mail-client-version"),
  };
}

function mockSignedInUser(): void {
  mockUser(
    {
      id: "test-user-123",
      fullName: "Test User",
      email: "test@example.com",
    },
    { token: "test-token" },
  );
  context.signal.addEventListener("abort", () => {
    clearMockedAuth();
  });
}

function setBrowserUrl(url: string): void {
  window.location.href = url;
}

function getFetchForTest() {
  // eslint-disable-next-line ccstate/no-direct-fetch -- this regression test file covers fetch$ itself.
  return context.store.get(fetch$);
}

describe("api client headers", () => {
  it("adds type, version, session, and per-request ids to contract requests", async () => {
    const observedHeaders: ObservedClientHeaders[] = [];
    const agentId = "c0000000-0000-4000-a000-000000000001";
    context.mocks.api(
      zeroUserConnectorsContract.get,
      ({ request, respond }) => {
        observedHeaders.push(observedClientHeaders(request));
        return respond(200, { enabledConnectorSlugs: [] });
      },
    );

    const client = context.store.get(zeroClient$)(zeroUserConnectorsContract);

    await accept(
      client.get({
        params: { id: agentId },
        extraHeaders: {
          "X-Client-Request-Id": "caller-request-id",
          "X-Client-Session-Id": "caller-session-id",
          "X-Client-Type": "caller-type",
          "X-Client-Version": "caller-version",
        },
      }),
      [200],
    );
    await accept(client.get({ params: { id: agentId } }), [200]);

    expect(observedHeaders).toHaveLength(2);
    const [first, second] = observedHeaders;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first.type).toBe("App");
    expect(second.type).toBe("App");
    expect(first.version).toBe(EXPECTED_CLIENT_VERSION);
    expect(second.version).toBe(EXPECTED_CLIENT_VERSION);
    expect(first.zeroMailVersion).toBe("3");
    expect(second.zeroMailVersion).toBe("3");
    expect(first.sessionId).toMatch(UUID_REGEX);
    expect(second.sessionId).toBe(first.sessionId);
    expect(first.requestId).toMatch(UUID_REGEX);
    expect(second.requestId).toMatch(UUID_REGEX);
    expect(second.requestId).not.toBe(first.requestId);
  });

  it("adds type, version, session, and per-request ids to fetch$ requests", async () => {
    mockSignedInUser();
    const observedHeaders: ObservedClientHeaders[] = [];
    context.mocks.http.get("*/api/zero/client-header-test", ({ request }) => {
      observedHeaders.push(observedClientHeaders(request));
      return new Response(null, { status: 204 });
    });

    const fetcher = getFetchForTest();

    await fetcher("/api/zero/client-header-test", {
      headers: {
        "X-Client-Request-Id": "caller-request-id",
        "X-Client-Session-Id": "caller-session-id",
        "X-Client-Type": "caller-type",
        "X-Client-Version": "caller-version",
      },
    });
    await fetcher("/api/zero/client-header-test");

    expect(observedHeaders).toHaveLength(2);
    const [first, second] = observedHeaders;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first.type).toBe("App");
    expect(second.type).toBe("App");
    expect(first.version).toBe(EXPECTED_CLIENT_VERSION);
    expect(second.version).toBe(EXPECTED_CLIENT_VERSION);
    expect(first.zeroMailVersion).toBe("3");
    expect(second.zeroMailVersion).toBe("3");
    expect(first.sessionId).toMatch(UUID_REGEX);
    expect(second.sessionId).toBe(first.sessionId);
    expect(first.requestId).toMatch(UUID_REGEX);
    expect(second.requestId).toMatch(UUID_REGEX);
    expect(second.requestId).not.toBe(first.requestId);
  });

  it("retries fetch$ auth recovery network failures without redirecting", async () => {
    mockSignedInUser();
    context.store.set(setRootSignal$, context.signal);
    let requests = 0;
    let forcedTokenRefreshes = 0;
    context.mocks.http.get("*/api/zero/auth-recovery-test", () => {
      requests += 1;
      if (requests === 1) {
        return HttpResponse.json(
          {
            error: {
              code: "UNAUTHORIZED",
              message: "Unauthorized",
            },
          },
          { status: 401 },
        );
      }
      if (requests === 2) {
        return HttpResponse.error();
      }
      return HttpResponse.json({ recovered: true });
    });
    mockedClerk.sessionGetToken.mockImplementation((options) => {
      if (options?.skipCache) {
        forcedTokenRefreshes += 1;
        if (forcedTokenRefreshes === 1) {
          return Promise.reject(
            Object.assign(new Error("Clerk is offline"), {
              code: "clerk_offline",
            }),
          );
        }
        if (forcedTokenRefreshes === 2) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return Promise.resolve("fresh-token");
      }
      return Promise.resolve("test-token");
    });

    const response = await getFetchForTest()("/api/zero/auth-recovery-test");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ recovered: true });
    expect(requests).toBe(3);
    expect(forcedTokenRefreshes).toBe(3);
    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
  });

  it("redirects fetch$ when the fresh-token replay remains unauthorized", async () => {
    mockSignedInUser();
    context.store.set(setRootSignal$, context.signal);
    let requests = 0;
    context.mocks.http.get("*/api/zero/auth-recovery-test", () => {
      requests += 1;
      return HttpResponse.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Unauthorized",
          },
        },
        { status: 401 },
      );
    });
    mockedClerk.sessionGetToken.mockImplementation((options) => {
      return Promise.resolve(options?.skipCache ? "fresh-token" : "test-token");
    });

    const response = await getFetchForTest()("/api/zero/auth-recovery-test");

    expect(response.status).toBe(401);
    expect(requests).toBe(2);
    expect(mockedClerk.redirectToSignIn).toHaveBeenCalledWith();
  });

  it("forwards the captured omby preview bypass to vm6 API requests", async () => {
    setBrowserUrl(
      "https://pr-22085-app.omby.ai/?x-vercel-protection-bypass=preview-secret",
    );
    mockSignedInUser();
    const observedBypassHeaders: (string | null)[] = [];
    const agentId = "c0000000-0000-4000-a000-000000000001";
    context.mocks.api(
      zeroUserConnectorsContract.get,
      ({ request, respond }) => {
        observedBypassHeaders.push(
          request.headers.get("x-vercel-protection-bypass"),
        );
        return respond(200, { enabledConnectorSlugs: [] });
      },
    );
    context.mocks.http.get("*/api/zero/preview-bypass-test", ({ request }) => {
      observedBypassHeaders.push(
        request.headers.get("x-vercel-protection-bypass"),
      );
      return new Response(null, { status: 204 });
    });

    const client = context.store.get(zeroClient$)(zeroUserConnectorsContract);
    await accept(client.get({ params: { id: agentId } }), [200]);
    await getFetchForTest()("/api/zero/preview-bypass-test");

    expect(observedBypassHeaders).toStrictEqual([
      "preview-secret",
      "preview-secret",
    ]);
  });

  it("does not forward an omby lookalike preview bypass", async () => {
    setBrowserUrl(
      "https://pr-22085-app.omby.ai.evil.example/?x-vercel-protection-bypass=preview-secret",
    );
    mockSignedInUser();
    let observedBypassHeader: string | null = "not-called";
    context.mocks.http.get("*/api/zero/preview-bypass-test", ({ request }) => {
      observedBypassHeader = request.headers.get("x-vercel-protection-bypass");
      return new Response(null, { status: 204 });
    });

    await getFetchForTest()("/api/zero/preview-bypass-test");

    expect(observedBypassHeader).toBeNull();
  });

  it("opens the force upgrade dialog for contract client responses", async () => {
    context.store.set(listenForceUpgradeDialog$, context.signal);
    const agentId = "c0000000-0000-4000-a000-000000000001";
    context.mocks.http.get("*/api/zero/agents/:id/user-connectors", () => {
      return Response.json(
        { error: "Client update required" },
        { status: CLIENT_FORCE_UPGRADE_STATUS },
      );
    });

    const client = context.store.get(zeroClient$)(zeroUserConnectorsContract);
    const response = await client.get({ params: { id: agentId } });

    expect(response.status).toBe(CLIENT_FORCE_UPGRADE_STATUS);
    expect(context.store.get(forceUpgradeDialogOpen$)).toBeTruthy();
  });

  it("opens the force upgrade dialog for fetch$ responses", async () => {
    mockSignedInUser();
    context.store.set(listenForceUpgradeDialog$, context.signal);
    context.mocks.http.get("*/api/zero/force-upgrade-test", () => {
      return Response.json(
        { error: "Client update required" },
        { status: CLIENT_FORCE_UPGRADE_STATUS },
      );
    });

    const fetcher = getFetchForTest();
    const response = await fetcher("/api/zero/force-upgrade-test");

    expect(response.status).toBe(CLIENT_FORCE_UPGRADE_STATUS);
    expect(context.store.get(forceUpgradeDialogOpen$)).toBeTruthy();
  });
});
