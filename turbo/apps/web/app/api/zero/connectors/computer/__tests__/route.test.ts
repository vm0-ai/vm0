import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../../src/mocks/server";
import { GET, POST, DELETE } from "../route";
import {
  createTestRequest,
  createTestOrg,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../../src/lib/auth/sandbox-token";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zcomp");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function computerUrl(): string {
  return `http://localhost:3000/api/zero/connectors/computer`;
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
        id: "bot_test_123",
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
        id: "cr_test_456",
        token: "2abc_test_ngrok_authtoken",
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
        id: "rd_test_abc",
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
        id: "ep_test_789",
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
  return createTestRequest(computerUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

describe("POST /api/zero/connectors/computer", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest(computerUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
  });

  it("should create computer connector", async () => {
    const userId = uniqueId("zcomp-create");
    await setupOrg(userId);
    const ngrokCalls = setupNgrokMocks();

    const response = await POST(createPostRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBeDefined();
    expect(data.ngrokToken).toBe("2abc_test_ngrok_authtoken");
    expect(data.bridgeToken).toBeDefined();
    expect(data.endpointPrefix).toContain("vm0-user-");
    expect(data.domain).toContain(".ngrok-free.app");

    expect(ngrokCalls.createBotUser.length).toBe(1);
    expect(ngrokCalls.createCredential.length).toBe(1);
    expect(ngrokCalls.createReservedDomain.length).toBe(1);
    expect(ngrokCalls.createEndpoint.length).toBe(1);
  });

  it("should clean up resources when endpoint creation fails", async () => {
    const userId = uniqueId("zcomp-fail");
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
    expect(ngrokCalls.deleteBotUser).toEqual(["bot_test_123"]);
    expect(ngrokCalls.deleteCredential).toEqual(["cr_test_456"]);
    expect(ngrokCalls.deleteReservedDomain).toEqual(["rd_test_abc"]);
  });

  it("should return 409 if connector already exists", async () => {
    const userId = uniqueId("zcomp-dup");
    await setupOrg(userId);
    setupNgrokMocks();

    const response1 = await POST(createPostRequest());
    expect(response1.status).toBe(200);

    const response2 = await POST(createPostRequest());
    expect(response2.status).toBe(409);
  });
});

describe("GET /api/zero/connectors/computer", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(createTestRequest(computerUrl()));
    expect(response.status).toBe(401);
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mockClerk({ userId: uniqueId("zcomp-no-org"), orgId: null });

    const response = await GET(createTestRequest(computerUrl()));

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for a sandbox token without connector:read capability", async () => {
    const token = await generateSandboxToken(
      uniqueId("zcomp-sandbox-user"),
      "run-1",
      "org-test",
    );

    const response = await GET(
      createTestRequest(computerUrl(), {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error.message).toBe(
      "Missing required capability: connector:read",
    );
  });

  it("should return 404 if connector not found", async () => {
    const userId = uniqueId("zcomp-nf");
    await setupOrg(userId);

    const response = await GET(createTestRequest(computerUrl()));
    expect(response.status).toBe(404);
  });

  it("should return connector details", async () => {
    const userId = uniqueId("zcomp-get");
    await setupOrg(userId);
    setupNgrokMocks();

    await POST(createPostRequest());

    const response = await GET(createTestRequest(computerUrl()));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe("computer");
    expect(data.authMethod).toBe("api");
  });
});

describe("DELETE /api/zero/connectors/computer", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await DELETE(
      createTestRequest(computerUrl(), { method: "DELETE" }),
    );
    expect(response.status).toBe(401);
  });

  it("should return 404 if connector not found", async () => {
    const userId = uniqueId("zcomp-del-nf");
    await setupOrg(userId);

    const response = await DELETE(
      createTestRequest(computerUrl(), { method: "DELETE" }),
    );
    expect(response.status).toBe(404);
  });

  it("should delete connector and clean up", async () => {
    const userId = uniqueId("zcomp-del");
    await setupOrg(userId);
    const ngrokCalls = setupNgrokMocks();

    await POST(createPostRequest());

    const response = await DELETE(
      createTestRequest(computerUrl(), { method: "DELETE" }),
    );
    expect(response.status).toBe(204);

    expect(ngrokCalls.deleteCredential).toEqual(["cr_test_456"]);
    expect(ngrokCalls.deleteEndpoint).toEqual(["ep_test_789"]);
    expect(ngrokCalls.deleteReservedDomain).toEqual(["rd_test_abc"]);
    expect(ngrokCalls.deleteBotUser).toEqual(["bot_test_123"]);

    // Verify GET returns 404
    const getResponse = await GET(createTestRequest(computerUrl()));
    expect(getResponse.status).toBe(404);
  });
});
