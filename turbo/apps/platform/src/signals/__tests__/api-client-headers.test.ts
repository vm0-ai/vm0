import { describe, expect, it } from "vitest";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";

import { clearMockedAuth, mockUser } from "../../__tests__/mock-auth.ts";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { fetch$ } from "../fetch.ts";
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

describe("platform api client headers", () => {
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

    // eslint-disable-next-line ccstate/no-direct-fetch -- this regression test covers fetch$ itself.
    const fetcher = context.store.get(fetch$);

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
});
