import { randomUUID } from "node:crypto";

import {
  zeroComputerUseHostContract,
  zeroComputerUseRegisterContract,
  zeroComputerUseUnregisterContract,
} from "@vm0/api-contracts/contracts/zero-computer-use";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  type ComputerUseScenarioFixture,
  deleteComputerUseScenario$,
  seedComputerUseScenario$,
} from "./helpers/zero-computer-use";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface NgrokCalls {
  createBotUser: string[];
  listBotUsers: number;
  filterEndpoints: string[];
  patchEndpoint: string[];
  filterReservedDomains: string[];
  createCredential: string[];
  deleteCredential: string[];
  createEndpoint: string[];
  deleteEndpoint: string[];
  createReservedDomain: string[];
  deleteReservedDomain: string[];
  deleteBotUser: string[];
}

function setupNgrokMocks(): NgrokCalls {
  const calls: NgrokCalls = {
    createBotUser: [],
    listBotUsers: 0,
    filterEndpoints: [],
    patchEndpoint: [],
    filterReservedDomains: [],
    createCredential: [],
    deleteCredential: [],
    createEndpoint: [],
    deleteEndpoint: [],
    createReservedDomain: [],
    deleteReservedDomain: [],
    deleteBotUser: [],
  };

  server.use(
    http.post("https://api.ngrok.com/bot_users", async ({ request }) => {
      const body = (await request.json()) as { name: string };
      calls.createBotUser.push(body.name);
      return HttpResponse.json({ id: "bot_test_cu_123", name: body.name });
    }),
    http.get("https://api.ngrok.com/bot_users", () => {
      calls.listBotUsers++;
      return HttpResponse.json({ bot_users: [], next_page_uri: null });
    }),
    http.post("https://api.ngrok.com/credentials", async ({ request }) => {
      const body = (await request.json()) as {
        owner_id: string;
        acl: string[];
      };
      calls.createCredential.push(body.owner_id);
      return HttpResponse.json({
        id: "cr_test_cu_456",
        token: "2abc_test_ngrok_cu_authtoken",
      });
    }),
    http.delete("https://api.ngrok.com/credentials/:id", ({ params }) => {
      calls.deleteCredential.push(params.id as string);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get("https://api.ngrok.com/reserved_domains", ({ request }) => {
      const url = new URL(request.url);
      const filter = url.searchParams.get("filter");
      calls.filterReservedDomains.push(filter ?? "");
      return HttpResponse.json({
        reserved_domains: [],
        next_page_uri: null,
      });
    }),
    http.post("https://api.ngrok.com/reserved_domains", async ({ request }) => {
      const body = (await request.json()) as { name: string; region: string };
      calls.createReservedDomain.push(body.name);
      return HttpResponse.json({
        id: "rd_test_cu_abc",
        domain: `${body.name}.ngrok-free.app`,
        region: body.region,
        cname_target: null,
      });
    }),
    http.delete("https://api.ngrok.com/reserved_domains/:id", ({ params }) => {
      calls.deleteReservedDomain.push(params.id as string);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get("https://api.ngrok.com/endpoints", ({ request }) => {
      const url = new URL(request.url);
      const filter = url.searchParams.get("filter");
      calls.filterEndpoints.push(filter ?? "");
      return HttpResponse.json({ endpoints: [], next_page_uri: null });
    }),
    http.patch("https://api.ngrok.com/endpoints/:id", ({ params }) => {
      calls.patchEndpoint.push(params.id as string);
      return HttpResponse.json({
        id: params.id as string,
        url: "https://*.patched.ngrok-free.app",
      });
    }),
    http.post("https://api.ngrok.com/endpoints", async ({ request }) => {
      const body = (await request.json()) as { url: string };
      calls.createEndpoint.push(body.url);
      return HttpResponse.json({ id: "ep_test_cu_789", url: body.url });
    }),
    http.delete("https://api.ngrok.com/endpoints/:id", ({ params }) => {
      calls.deleteEndpoint.push(params.id as string);
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete("https://api.ngrok.com/bot_users/:id", ({ params }) => {
      calls.deleteBotUser.push(params.id as string);
      return new HttpResponse(null, { status: 204 });
    }),
  );

  return calls;
}

describe("GET /api/zero/computer-use/host", () => {
  const track = createFixtureTracker<ComputerUseScenarioFixture>((fixture) => {
    return store.set(deleteComputerUseScenario$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroComputerUseHostContract);

    const response = await accept(client.getHost({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroComputerUseHostContract);

    const response = await accept(
      client.getHost({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 when the computer-use feature switch is disabled", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroComputerUseHostContract);

    const response = await accept(
      client.getHost({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Computer use is not enabled", code: "FORBIDDEN" },
    });
  });

  it("returns 404 when no active host is registered", async () => {
    const fixture = await track(
      store.set(
        seedComputerUseScenario$,
        { computerUseEnabled: true },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroComputerUseHostContract);

    const response = await accept(
      client.getHost({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "No active computer-use host", code: "NOT_FOUND" },
    });
  });

  it("returns host details when a host is registered", async () => {
    const fixture = await track(
      store.set(
        seedComputerUseScenario$,
        {
          computerUseEnabled: true,
          host: {
            domain: "abc.ngrok-free.app",
            token: "host_token_xyz",
          },
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroComputerUseHostContract);

    const response = await accept(
      client.getHost({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      domain: "abc.ngrok-free.app",
      token: "host_token_xyz",
    });
  });
});

describe("POST /api/zero/computer-use/register", () => {
  const track = createFixtureTracker<ComputerUseScenarioFixture>((fixture) => {
    return store.set(deleteComputerUseScenario$, fixture, context.signal);
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroComputerUseRegisterContract);

    const response = await accept(client.register({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 when the computer-use feature switch is disabled", async () => {
    const fixture = await track(
      store.set(
        seedComputerUseScenario$,
        { computerUseEnabled: false },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroComputerUseRegisterContract);

    const response = await accept(
      client.register({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Computer use is not enabled", code: "FORBIDDEN" },
    });
  });

  it("registers a computer-use host", async () => {
    const fixture = await track(
      store.set(
        seedComputerUseScenario$,
        { computerUseEnabled: true },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockOptionalEnv("NGROK_API_KEY", "test-ngrok-key");
    const ngrokCalls = setupNgrokMocks();

    const client = setupApp({ context })(zeroComputerUseRegisterContract);

    const response = await accept(
      client.register({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.id).toBeDefined();
    expect(response.body.ngrokToken).toBe("2abc_test_ngrok_cu_authtoken");
    expect(response.body.token).toBeDefined();
    expect(response.body.endpointPrefix).toContain("vm0-cu-");
    expect(response.body.domain).toContain(".ngrok-free.app");

    expect(ngrokCalls.createBotUser).toHaveLength(1);
    expect(ngrokCalls.createCredential).toHaveLength(1);
    expect(ngrokCalls.filterReservedDomains).toHaveLength(1);
    expect(ngrokCalls.createReservedDomain).toHaveLength(1);
    expect(ngrokCalls.filterEndpoints).toHaveLength(1);
    expect(ngrokCalls.createEndpoint).toHaveLength(1);
  });

  it("cleans up resources when endpoint creation fails", async () => {
    const fixture = await track(
      store.set(
        seedComputerUseScenario$,
        { computerUseEnabled: true },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockOptionalEnv("NGROK_API_KEY", "test-ngrok-key");
    const ngrokCalls = setupNgrokMocks();

    server.use(
      http.post("https://api.ngrok.com/endpoints", () => {
        return HttpResponse.json({ error: "internal error" }, { status: 500 });
      }),
    );

    const client = setupApp({ context })(zeroComputerUseRegisterContract);

    await expect(
      client.register({
        headers: { authorization: "Bearer clerk-session" },
      }),
    ).rejects.toThrow();

    expect(ngrokCalls.deleteBotUser).toStrictEqual(["bot_test_cu_123"]);
    expect(ngrokCalls.deleteCredential).toStrictEqual(["cr_test_cu_456"]);
    expect(ngrokCalls.deleteReservedDomain).toStrictEqual(["rd_test_cu_abc"]);
  });

  it("updates an existing orphaned endpoint instead of creating a new one", async () => {
    const fixture = await track(
      store.set(
        seedComputerUseScenario$,
        { computerUseEnabled: true },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockOptionalEnv("NGROK_API_KEY", "test-ngrok-key");
    const ngrokCalls = setupNgrokMocks();

    server.use(
      http.get("https://api.ngrok.com/reserved_domains", ({ request }) => {
        const url = new URL(request.url);
        const filter = url.searchParams.get("filter");
        ngrokCalls.filterReservedDomains.push(filter ?? "");
        return HttpResponse.json({
          reserved_domains: [
            {
              id: "rd_orphan_123",
              domain: "orphan.ngrok-free.app",
              region: "us",
              cname_target: null,
            },
          ],
          next_page_uri: null,
        });
      }),
      http.get("https://api.ngrok.com/endpoints", ({ request }) => {
        const url = new URL(request.url);
        const filter = url.searchParams.get("filter");
        ngrokCalls.filterEndpoints.push(filter ?? "");
        return HttpResponse.json({
          endpoints: [
            { id: "ep_orphaned_123", url: "https://*.orphan.ngrok-free.app" },
          ],
          next_page_uri: null,
        });
      }),
    );

    const client = setupApp({ context })(zeroComputerUseRegisterContract);

    const response = await accept(
      client.register({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.id).toBeDefined();
    expect(ngrokCalls.patchEndpoint).toStrictEqual(["ep_orphaned_123"]);
    expect(ngrokCalls.createEndpoint).toHaveLength(0);
  });

  it("returns 200 on re-registration (idempotent)", async () => {
    const fixture = await track(
      store.set(
        seedComputerUseScenario$,
        { computerUseEnabled: true },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockOptionalEnv("NGROK_API_KEY", "test-ngrok-key");
    setupNgrokMocks();

    const client = setupApp({ context })(zeroComputerUseRegisterContract);

    const r1 = await accept(
      client.register({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(r1.body.id).toBeDefined();

    setupNgrokMocks();
    const r2 = await accept(
      client.register({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(r2.body.domain).toBeDefined();
    expect(r2.body.token).toBeDefined();
  });
});

describe("DELETE /api/zero/computer-use/unregister", () => {
  const track = createFixtureTracker<ComputerUseScenarioFixture>((fixture) => {
    return store.set(deleteComputerUseScenario$, fixture, context.signal);
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroComputerUseUnregisterContract);

    const response = await accept(client.unregister({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 when the computer-use feature switch is disabled", async () => {
    const fixture = await track(
      store.set(
        seedComputerUseScenario$,
        { computerUseEnabled: false },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroComputerUseUnregisterContract);

    const response = await accept(
      client.unregister({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Computer use is not enabled", code: "FORBIDDEN" },
    });
  });

  it("returns 404 when no host is registered", async () => {
    const fixture = await track(
      store.set(
        seedComputerUseScenario$,
        { computerUseEnabled: true },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroComputerUseUnregisterContract);

    const response = await accept(
      client.unregister({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Computer-use host not found", code: "NOT_FOUND" },
    });
  });

  it("unregisters the host and cleans up ngrok resources", async () => {
    const fixture = await track(
      store.set(
        seedComputerUseScenario$,
        { computerUseEnabled: true },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockOptionalEnv("NGROK_API_KEY", "test-ngrok-key");
    const ngrokCalls = setupNgrokMocks();

    const registerClient = setupApp({ context })(
      zeroComputerUseRegisterContract,
    );
    await accept(
      registerClient.register({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const unregisterClient = setupApp({ context })(
      zeroComputerUseUnregisterContract,
    );
    const response = await accept(
      unregisterClient.unregister({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    expect(response.body).toBeUndefined();

    expect(ngrokCalls.deleteCredential).toStrictEqual(["cr_test_cu_456"]);
    expect(ngrokCalls.deleteEndpoint).toStrictEqual(["ep_test_cu_789"]);
    expect(ngrokCalls.deleteReservedDomain).toStrictEqual(["rd_test_cu_abc"]);
    expect(ngrokCalls.deleteBotUser).toStrictEqual(["bot_test_cu_123"]);

    const getClient = setupApp({ context })(zeroComputerUseHostContract);
    const getResponse = await accept(
      getClient.getHost({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(getResponse.body).toStrictEqual({
      error: { message: "No active computer-use host", code: "NOT_FOUND" },
    });
  });
});
