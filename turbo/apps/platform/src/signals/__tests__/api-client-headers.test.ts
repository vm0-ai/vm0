import { describe, expect, it } from "vitest";
import { CLIENT_FORCE_UPGRADE_STATUS } from "@vm0/api-contracts/contracts/client-headers";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";

import { clearMockedAuth, mockUser } from "../../__tests__/mock-auth.ts";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { fetch$ } from "../fetch.ts";
import {
  forceUpgradeDialogOpen$,
  listenForceUpgradeDialog$,
} from "../force-upgrade.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface ObservedClientHeaders {
  readonly requestId: string | null;
  readonly sessionId: string | null;
  readonly type: string | null;
  readonly version: string | null;
}

function observedClientHeaders(request: Request): ObservedClientHeaders {
  return {
    requestId: request.headers.get("x-client-request-id"),
    sessionId: request.headers.get("x-client-session-id"),
    type: request.headers.get("x-client-type"),
    version: request.headers.get("x-client-version"),
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
        return respond(200, { enabledTypes: [] });
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
    expect(first.version).toBe("0.540.0");
    expect(second.version).toBe("0.540.0");
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
    expect(first.version).toBe("0.540.0");
    expect(second.version).toBe("0.540.0");
    expect(first.sessionId).toMatch(UUID_REGEX);
    expect(second.sessionId).toBe(first.sessionId);
    expect(first.requestId).toMatch(UUID_REGEX);
    expect(second.requestId).toMatch(UUID_REGEX);
    expect(second.requestId).not.toBe(first.requestId);
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
