import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server.ts";
import { zeroClient$ } from "../api-client.ts";
import { zeroOrgContract } from "@vm0/api-contracts/contracts/zero-org";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { zeroUserPreferencesContract } from "@vm0/api-contracts/contracts/zero-user-preferences";
import { zeroTeamContract } from "@vm0/api-contracts/contracts/zero-team";
import { onboardingStatusContract } from "@vm0/api-contracts/contracts/onboarding";
import { zeroVoiceIoQuotaContract } from "@vm0/api-contracts/contracts/zero-voice-io-quota";
import { zeroSchedulesMainContract } from "@vm0/api-contracts/contracts/zero-schedules";
import { zeroConnectorsMainContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { testContext } from "./test-helpers.ts";
import { detachedSetupPage } from "../../__tests__/page-helper.ts";
import { mockedClerk } from "../../__tests__/mock-auth.ts";
import { createMockApi } from "../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

describe("zeroClient$ 401 redirect", () => {
  it("should redirect to sign-in when API returns 401", async () => {
    server.use(
      mockApi(zeroOrgContract.get, ({ respond }) => {
        return respond(401, {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        });
      }),
    );

    mockedClerk.redirectToSignIn.mockClear();

    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract);
    const result = await client.get();

    expect(result.status).toBe(401);
    expect(mockedClerk.redirectToSignIn).toHaveBeenCalledWith();
  });

  it("should not redirect on non-401 errors", async () => {
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    server.use(
      // mockApi cannot be used here: 403 is not declared in zeroOrgContract.get responses,
      // so this raw handler is the only way to simulate a forbidden response for this test.
      http.get("*/api/zero/org", () => {
        return HttpResponse.json(
          { error: { message: "Forbidden", code: "FORBIDDEN" } },
          { status: 403 },
        );
      }),
    );

    mockedClerk.redirectToSignIn.mockClear();

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract);
    const result = await client.get();

    expect(result.status).toBe(403);
    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
  });

  it("refreshes the token and retries once on 401, returning success", async () => {
    detachedSetupPage({
      context,
      path: "/",
      session: { token: "stale-token" },
      withoutRender: true,
    });

    mockedClerk.redirectToSignIn.mockClear();
    mockedClerk.sessionGetToken.mockReset();
    mockedClerk.sessionGetToken.mockImplementation((opts) => {
      return Promise.resolve(opts?.skipCache ? "fresh-token" : "stale-token");
    });

    const authHeaders: string[] = [];
    server.use(
      mockApi(zeroOrgContract.get, ({ request, respond }) => {
        authHeaders.push(request.headers.get("authorization") ?? "");
        if (authHeaders.length === 1) {
          return respond(401, {
            error: { message: "Unauthorized", code: "UNAUTHORIZED" },
          });
        }
        return respond(200, {
          id: "org_1",
          name: "Org",
          slug: "org-1",
          role: "admin",
        });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract);
    const result = await client.get();

    expect(result.status).toBe(200);
    expect(authHeaders).toStrictEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
    ]);
    expect(mockedClerk.sessionGetToken).toHaveBeenCalledWith({
      skipCache: true,
    });
    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
  });

  it("redirects when retry also returns 401", async () => {
    detachedSetupPage({
      context,
      path: "/",
      session: { token: "stale-token" },
      withoutRender: true,
    });

    mockedClerk.redirectToSignIn.mockClear();
    mockedClerk.sessionGetToken.mockReset();
    mockedClerk.sessionGetToken.mockImplementation((opts) => {
      return Promise.resolve(opts?.skipCache ? "fresh-token" : "stale-token");
    });

    const authHeaders: string[] = [];
    server.use(
      mockApi(zeroOrgContract.get, ({ request, respond }) => {
        authHeaders.push(request.headers.get("authorization") ?? "");
        return respond(401, {
          error: { message: "Unauthorized", code: "UNAUTHORIZED" },
        });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract);
    const result = await client.get();

    expect(result.status).toBe(401);
    expect(authHeaders).toStrictEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
    ]);
    expect(mockedClerk.redirectToSignIn).toHaveBeenCalledTimes(1);
  });

  it("skips retry and redirects when the refreshed token is null", async () => {
    detachedSetupPage({
      context,
      path: "/",
      session: { token: "stale-token" },
      withoutRender: true,
    });

    mockedClerk.redirectToSignIn.mockClear();
    mockedClerk.sessionGetToken.mockReset();
    mockedClerk.sessionGetToken.mockImplementation((opts) => {
      return Promise.resolve(opts?.skipCache ? null : "stale-token");
    });

    const authHeaders: string[] = [];
    server.use(
      mockApi(zeroOrgContract.get, ({ request, respond }) => {
        authHeaders.push(request.headers.get("authorization") ?? "");
        return respond(401, {
          error: { message: "Unauthorized", code: "UNAUTHORIZED" },
        });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract);
    const result = await client.get();

    expect(result.status).toBe(401);
    expect(authHeaders).toStrictEqual(["Bearer stale-token"]);
    expect(mockedClerk.redirectToSignIn).toHaveBeenCalledTimes(1);
  });

  it("skips retry when the refreshed token equals the initial token", async () => {
    detachedSetupPage({
      context,
      path: "/",
      session: { token: "same-token" },
      withoutRender: true,
    });

    mockedClerk.redirectToSignIn.mockClear();
    mockedClerk.sessionGetToken.mockReset();
    mockedClerk.sessionGetToken.mockResolvedValue("same-token");

    const authHeaders: string[] = [];
    server.use(
      mockApi(zeroOrgContract.get, ({ request, respond }) => {
        authHeaders.push(request.headers.get("authorization") ?? "");
        return respond(401, {
          error: { message: "Unauthorized", code: "UNAUTHORIZED" },
        });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract);
    const result = await client.get();

    expect(result.status).toBe(401);
    expect(authHeaders).toStrictEqual(["Bearer same-token"]);
    expect(mockedClerk.redirectToSignIn).toHaveBeenCalledTimes(1);
  });

  it("can force the api backend base for a client", async () => {
    vi.stubGlobal(
      "location",
      new URL("https://platform.vm0.ai/chats/thread-1"),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-1",
      withoutRender: true,
    });

    const requestHosts: string[] = [];
    server.use(
      mockApi(zeroOrgContract.get, ({ request, respond }) => {
        requestHosts.push(new URL(request.url).host);
        return respond(200, {
          id: "org_1",
          name: "Org",
          slug: "org-1",
          role: "admin",
        });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract, { apiBase: "api" });
    const result = await client.get();

    expect(result.status).toBe(200);
    expect(requestHosts).toStrictEqual(["api.vm0.ai"]);
  });
});

describe("zeroClient$ apiBackend routing", () => {
  it("keeps POST contract requests on www when apiBackend is off", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const requestHosts: string[] = [];
    server.use(
      mockApi(zeroFeatureSwitchesContract.update, ({ request, respond }) => {
        requestHosts.push(new URL(request.url).host);
        return respond(200, { switches: {} });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroFeatureSwitchesContract);
    const result = await client.update({ body: { switches: {} } });

    expect(result.status).toBe(200);
    expect(requestHosts).toStrictEqual(["www.vm0.ai"]);
  });

  it("routes POST contract requests to api host when apiBackend is on", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { apiBackend: true },
    });

    const requestHosts: string[] = [];
    server.use(
      mockApi(zeroFeatureSwitchesContract.update, ({ request, respond }) => {
        requestHosts.push(new URL(request.url).host);
        return respond(200, { switches: {} });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroFeatureSwitchesContract);
    const result = await client.update({ body: { switches: {} } });

    expect(result.status).toBe(200);
    expect(requestHosts).toStrictEqual(["api.vm0.ai"]);
  });

  it("keeps non-allowlisted GET contract requests on www when apiBackend is off", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const requestHosts: string[] = [];
    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ request, respond }) => {
        requestHosts.push(new URL(request.url).host);
        return respond(200, {
          connectors: [],
          configuredTypes: [],
          connectorProvidedEnvNames: [],
        });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroConnectorsMainContract);
    const result = await client.list();

    expect(result.status).toBe(200);
    expect(requestHosts).toStrictEqual(["www.vm0.ai"]);
  });

  it("routes policy allowlisted user preferences contract requests to api host when apiBackend is off", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const requestHosts: string[] = [];
    server.use(
      mockApi(zeroUserPreferencesContract.get, ({ request, respond }) => {
        requestHosts.push(new URL(request.url).host);
        return respond(200, {
          timezone: null,
          pinnedAgentIds: [],
          sendMode: "enter",
          captureNetworkBodiesRemaining: 0,
        });
      }),
      mockApi(zeroUserPreferencesContract.update, ({ request, respond }) => {
        requestHosts.push(new URL(request.url).host);
        return respond(200, {
          timezone: "America/Los_Angeles",
          pinnedAgentIds: [],
          sendMode: "cmd-enter",
          captureNetworkBodiesRemaining: 0,
        });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroUserPreferencesContract);
    const getResult = await client.get();
    const updateResult = await client.update({
      body: { sendMode: "cmd-enter" },
    });

    expect(getResult.status).toBe(200);
    expect(updateResult.status).toBe(200);
    expect(requestHosts).toStrictEqual(["api.vm0.ai", "api.vm0.ai"]);
  });

  it("routes policy allowlisted team contract requests to api host when apiBackend is off", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const requestHosts: string[] = [];
    server.use(
      mockApi(zeroTeamContract.list, ({ request, respond }) => {
        requestHosts.push(new URL(request.url).host);
        return respond(200, []);
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroTeamContract);
    const result = await client.list();

    expect(result.status).toBe(200);
    expect(requestHosts).toStrictEqual(["api.vm0.ai"]);
  });

  it("routes policy allowlisted onboarding status contract requests to api host when apiBackend is off", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const requestHosts: string[] = [];
    server.use(
      mockApi(onboardingStatusContract.getStatus, ({ request, respond }) => {
        requestHosts.push(new URL(request.url).host);
        return respond(200, {
          needsOnboarding: false,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: "agent_1",
          defaultAgentMetadata: null,
        });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(onboardingStatusContract);
    const result = await client.getStatus();

    expect(result.status).toBe(200);
    // The onboard guard may also fetch status during page bootstrap; assert
    // every onboarding-status request routes to the api host, not the count.
    expect(requestHosts.length).toBeGreaterThan(0);
    expect([...new Set(requestHosts)]).toStrictEqual(["api.vm0.ai"]);
  });

  it("routes policy allowlisted org contract requests to api host when apiBackend is off", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const requestHosts: string[] = [];
    server.use(
      mockApi(zeroOrgContract.get, ({ request, respond }) => {
        requestHosts.push(new URL(request.url).host);
        return respond(200, {
          id: "org_1",
          name: "Org",
          slug: "org-1",
          role: "admin",
        });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract);
    const result = await client.get();

    expect(result.status).toBe(200);
    expect(requestHosts).toStrictEqual(["api.vm0.ai"]);
  });

  it("keeps same-path org mutation on www when apiBackend is off", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const requestHosts: string[] = [];
    server.use(
      mockApi(zeroOrgContract.update, ({ request, respond }) => {
        requestHosts.push(new URL(request.url).host);
        return respond(200, {
          id: "org_1",
          name: "Org",
          slug: "org-1",
          role: "admin",
        });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract);
    const result = await client.update({ body: { name: "Renamed" } });

    expect(result.status).toBe(200);
    expect(requestHosts).toStrictEqual(["www.vm0.ai"]);
  });

  it("routes policy allowlisted voice-io quota contract requests to api host when apiBackend is off", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const requestHosts: string[] = [];
    server.use(
      mockApi(zeroVoiceIoQuotaContract.get, ({ request, respond }) => {
        requestHosts.push(new URL(request.url).host);
        return respond(200, { allowed: true, count: 0, limit: null });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroVoiceIoQuotaContract);
    const result = await client.get();

    expect(result.status).toBe(200);
    expect(requestHosts).toStrictEqual(["api.vm0.ai"]);
  });

  it("routes policy allowlisted schedules list contract requests to api host when apiBackend is off", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const requestHosts: string[] = [];
    server.use(
      mockApi(zeroSchedulesMainContract.list, ({ request, respond }) => {
        requestHosts.push(new URL(request.url).host);
        return respond(200, { schedules: [] });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroSchedulesMainContract);
    const result = await client.list();

    expect(result.status).toBe(200);
    expect(requestHosts).toStrictEqual(["api.vm0.ai"]);
  });

  it("routes GET contract requests to api host when apiBackend is on", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { apiBackend: true },
    });

    const requestHosts: string[] = [];
    server.use(
      mockApi(zeroOrgContract.get, ({ request, respond }) => {
        requestHosts.push(new URL(request.url).host);
        return respond(200, {
          id: "org_1",
          name: "Org",
          slug: "org-1",
          role: "admin",
        });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract);
    const result = await client.get();

    expect(result.status).toBe(200);
    expect(requestHosts).toStrictEqual(["api.vm0.ai"]);
  });

  it("apiBase: 'api' override still wins for GET when apiBackend is off", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const requestHosts: string[] = [];
    server.use(
      mockApi(zeroOrgContract.get, ({ request, respond }) => {
        requestHosts.push(new URL(request.url).host);
        return respond(200, {
          id: "org_1",
          name: "Org",
          slug: "org-1",
          role: "admin",
        });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract, { apiBase: "api" });
    const result = await client.get();

    expect(result.status).toBe(200);
    expect(requestHosts).toStrictEqual(["api.vm0.ai"]);
  });
});
