import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../src/mocks/server";
import { POST } from "../register/route";
import { DELETE } from "../unregister/route";
import { GET } from "../host/route";
import {
  createTestRequest,
  createTestOrg,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

// Mock isFeatureEnabled to return true by default (staff user)
vi.mock("@vm0/core/feature-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vm0/core/feature-switch")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

// Import after mock setup so we can control the mock
const { isFeatureEnabled } = await import("@vm0/core/feature-switch");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zcu");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function registerUrl(): string {
  return `http://localhost:3000/api/zero/computer-use/register`;
}

function unregisterUrl(): string {
  return `http://localhost:3000/api/zero/computer-use/unregister`;
}

function hostUrl(): string {
  return `http://localhost:3000/api/zero/computer-use/host`;
}

function setupNgrokMocks() {
  const calls = {
    createBotUser: [] as string[],
    listBotUsers: 0,
    filterEndpoints: [] as string[],
    patchEndpoint: [] as string[],
    filterReservedDomains: [] as string[],
    createCredential: [] as string[],
    deleteCredential: [] as string[],
    createEndpoint: [] as string[],
    deleteEndpoint: [] as string[],
    createReservedDomain: [] as string[],
    deleteReservedDomain: [] as string[],
    deleteBotUser: [] as string[],
  };

  server.use(
    http.post("https://api.ngrok.com/bot_users", async ({ request }) => {
      const body = (await request.json()) as { name: string };
      calls.createBotUser.push(body.name);
      return HttpResponse.json({
        id: "bot_test_cu_123",
        name: body.name,
      });
    }),
    http.get("https://api.ngrok.com/bot_users", () => {
      calls.listBotUsers++;
      return HttpResponse.json({
        bot_users: [],
        next_page_uri: null,
      });
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
      const body = (await request.json()) as {
        name: string;
        region: string;
      };
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
      return HttpResponse.json({
        endpoints: [],
        next_page_uri: null,
      });
    }),
    http.patch("https://api.ngrok.com/endpoints/:id", async ({ params }) => {
      calls.patchEndpoint.push(params.id as string);
      return HttpResponse.json({
        id: params.id as string,
        url: "https://*.patched.ngrok-free.app",
      });
    }),
    http.post("https://api.ngrok.com/endpoints", async ({ request }) => {
      const body = (await request.json()) as { url: string };
      calls.createEndpoint.push(body.url);
      return HttpResponse.json({
        id: "ep_test_cu_789",
        url: body.url,
      });
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

function createPostRequest() {
  return createTestRequest(registerUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

describe("POST /api/zero/computer-use/register", () => {
  beforeEach(() => {
    context.setupMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(createPostRequest());
    expect(response.status).toBe(401);
  });

  it("should return 403 when feature flag is disabled", async () => {
    const userId = uniqueId("zcu-ff");
    await setupOrg(userId);
    mockIsFeatureEnabled.mockReturnValue(false);

    const response = await POST(createPostRequest());
    expect(response.status).toBe(403);
  });

  it("should register computer-use host", async () => {
    const userId = uniqueId("zcu-reg");
    await setupOrg(userId);
    const ngrokCalls = setupNgrokMocks();

    const response = await POST(createPostRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBeDefined();
    expect(data.ngrokToken).toBe("2abc_test_ngrok_cu_authtoken");
    expect(data.token).toBeDefined();
    expect(data.endpointPrefix).toContain("vm0-cu-");
    expect(data.domain).toContain(".ngrok-free.app");

    expect(ngrokCalls.createBotUser.length).toBe(1);
    expect(ngrokCalls.createCredential.length).toBe(1);
    expect(ngrokCalls.filterReservedDomains.length).toBe(1);
    expect(ngrokCalls.createReservedDomain.length).toBe(1);
    expect(ngrokCalls.filterEndpoints.length).toBe(1);
    expect(ngrokCalls.createEndpoint.length).toBe(1);
  });

  it("should clean up resources when endpoint creation fails", async () => {
    const userId = uniqueId("zcu-fail");
    await setupOrg(userId);
    const ngrokCalls = setupNgrokMocks();

    // Override endpoint creation to fail
    server.use(
      http.post("https://api.ngrok.com/endpoints", () => {
        return HttpResponse.json({ error: "internal error" }, { status: 500 });
      }),
    );

    const response = await POST(createPostRequest());
    expect(response.status).toBe(500);

    // Verify all previously-created resources were cleaned up
    expect(ngrokCalls.deleteBotUser).toEqual(["bot_test_cu_123"]);
    expect(ngrokCalls.deleteCredential).toEqual(["cr_test_cu_456"]);
    expect(ngrokCalls.deleteReservedDomain).toEqual(["rd_test_cu_abc"]);
  });

  it("should update existing orphaned endpoint instead of creating new one", async () => {
    const userId = uniqueId("zcu-orphan");
    await setupOrg(userId);
    const ngrokCalls = setupNgrokMocks();

    // Override reserved domain lookup to return "orphan.ngrok-free.app" so the
    // endpoint URL built by the service (`https://*.orphan.ngrok-free.app`)
    // matches the orphaned endpoint below.
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

    const response = await POST(createPostRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBeDefined();

    // Should PATCH the existing endpoint, not create a new one
    expect(ngrokCalls.patchEndpoint).toEqual(["ep_orphaned_123"]);
    expect(ngrokCalls.createEndpoint.length).toBe(0);
  });

  it("should return 200 on re-registration (idempotent)", async () => {
    const userId = uniqueId("zcu-dup");
    await setupOrg(userId);
    setupNgrokMocks();

    const response1 = await POST(createPostRequest());
    expect(response1.status).toBe(200);

    setupNgrokMocks();
    const response2 = await POST(createPostRequest());
    expect(response2.status).toBe(200);
    const data = await response2.json();
    expect(data.domain).toBeDefined();
    expect(data.token).toBeDefined();
  });
});

describe("GET /api/zero/computer-use/host", () => {
  beforeEach(() => {
    context.setupMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(createTestRequest(hostUrl()));
    expect(response.status).toBe(401);
  });

  it("should return 401 when the user has no active org", async () => {
    mockClerk({ userId: uniqueId("zcu-host-no-org"), orgId: null });

    const response = await GET(createTestRequest(hostUrl()));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("should return 403 when feature flag is disabled", async () => {
    const userId = uniqueId("zcu-host-ff");
    await setupOrg(userId);
    mockIsFeatureEnabled.mockReturnValue(false);

    const response = await GET(createTestRequest(hostUrl()));
    expect(response.status).toBe(403);
  });

  it("should return 404 if no host registered", async () => {
    const userId = uniqueId("zcu-host-nf");
    await setupOrg(userId);

    const response = await GET(createTestRequest(hostUrl()));
    expect(response.status).toBe(404);
  });

  it("should return host details after registration", async () => {
    const userId = uniqueId("zcu-host-ok");
    await setupOrg(userId);
    setupNgrokMocks();

    await POST(createPostRequest());

    const response = await GET(createTestRequest(hostUrl()));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.domain).toContain(".ngrok-free.app");
    expect(data.token).toBeDefined();
  });
});

describe("DELETE /api/zero/computer-use/unregister", () => {
  beforeEach(() => {
    context.setupMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await DELETE(
      createTestRequest(unregisterUrl(), { method: "DELETE" }),
    );
    expect(response.status).toBe(401);
  });

  it("should return 403 when feature flag is disabled", async () => {
    const userId = uniqueId("zcu-unreg-ff");
    await setupOrg(userId);
    mockIsFeatureEnabled.mockReturnValue(false);

    const response = await DELETE(
      createTestRequest(unregisterUrl(), { method: "DELETE" }),
    );
    expect(response.status).toBe(403);
  });

  it("should return 404 if no host registered", async () => {
    const userId = uniqueId("zcu-unreg-nf");
    await setupOrg(userId);

    const response = await DELETE(
      createTestRequest(unregisterUrl(), { method: "DELETE" }),
    );
    expect(response.status).toBe(404);
  });

  it("should unregister host and clean up ngrok resources", async () => {
    const userId = uniqueId("zcu-unreg");
    await setupOrg(userId);
    const ngrokCalls = setupNgrokMocks();

    await POST(createPostRequest());

    const response = await DELETE(
      createTestRequest(unregisterUrl(), { method: "DELETE" }),
    );
    expect(response.status).toBe(204);

    expect(ngrokCalls.deleteCredential).toEqual(["cr_test_cu_456"]);
    expect(ngrokCalls.deleteEndpoint).toEqual(["ep_test_cu_789"]);
    expect(ngrokCalls.deleteReservedDomain).toEqual(["rd_test_cu_abc"]);
    expect(ngrokCalls.deleteBotUser).toEqual(["bot_test_cu_123"]);

    // Verify GET returns 404 after unregister
    const getResponse = await GET(createTestRequest(hostUrl()));
    expect(getResponse.status).toBe(404);
  });
});
