import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../src/mocks/server";
import { GET, POST, DELETE } from "../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

const BASE_URL = "http://localhost:3000/api/connectors/computer";

/**
 * Set up MSW handlers for ngrok API mocks.
 * Returns spy-able request tracking.
 */
function setupNgrokMocks() {
  const calls = {
    createBotUser: [] as string[],
    listBotUsers: 0,
    createCredential: [] as string[],
    deleteCredential: [] as string[],
    createEndpoint: [] as string[],
    deleteEndpoint: [] as string[],
    createReservedDomain: [] as string[],
    deleteReservedDomain: [] as string[],
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
    http.post("https://api.ngrok.com/reserved_domains", async ({ request }) => {
      const body = (await request.json()) as { name: string; region: string };
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
  );

  return calls;
}

function createPostRequest() {
  return createTestRequest(BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

describe("POST /api/connectors/computer - Create", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const response = await POST(createPostRequest());
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should create computer connector", async () => {
    await context.setupUser();
    const ngrokCalls = setupNgrokMocks();

    const response = await POST(createPostRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBeDefined();
    expect(data.ngrokToken).toBe("2abc_test_ngrok_authtoken");
    expect(data.bridgeToken).toBeDefined();
    expect(data.endpointPrefix).toContain("vm0-user-");
    expect(data.domain).toContain(".ngrok-free.app");

    // Verify ngrok API was called
    expect(ngrokCalls.createBotUser.length).toBe(1);
    expect(ngrokCalls.createCredential.length).toBe(1);
    expect(ngrokCalls.createCredential[0]).toBe("bot_test_123");
    expect(ngrokCalls.createReservedDomain.length).toBe(1);
    expect(ngrokCalls.createEndpoint.length).toBe(1);
    expect(ngrokCalls.createEndpoint[0]).toContain(".ngrok-free.app");

    // Verify connector exists via GET
    const getResponse = await GET(createTestRequest(BASE_URL));
    const connector = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(connector.authMethod).toBe("api");
    expect(connector.externalId).toBe("bot_test_123");
    expect(connector.externalUsername).toBe("cr_test_456");
  });

  it("should return 409 if connector already exists", async () => {
    await context.setupUser();
    setupNgrokMocks();

    // Create first
    const response1 = await POST(createPostRequest());
    expect(response1.status).toBe(200);

    // Create again — should conflict
    const response2 = await POST(createPostRequest());
    const data2 = await response2.json();

    expect(response2.status).toBe(409);
    expect(data2.error.code).toBe("CONFLICT");
  });
});

describe("GET /api/connectors/computer - Get", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(BASE_URL);
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 404 if connector not found", async () => {
    await context.setupUser();

    const request = createTestRequest(BASE_URL);
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return connector details", async () => {
    await context.setupUser();
    setupNgrokMocks();

    // Create first
    await POST(createPostRequest());

    // Get
    const response = await GET(createTestRequest(BASE_URL));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe("computer");
    expect(data.authMethod).toBe("api");
    expect(data.externalId).toBe("bot_test_123");
    expect(data.externalUsername).toBe("cr_test_456");
  });
});

describe("DELETE /api/connectors/computer - Delete", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(BASE_URL, { method: "DELETE" });
    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 404 if connector not found", async () => {
    await context.setupUser();

    const request = createTestRequest(BASE_URL, { method: "DELETE" });
    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should delete connector and clean up", async () => {
    await context.setupUser();
    const ngrokCalls = setupNgrokMocks();

    // Create
    await POST(createPostRequest());

    // Delete
    const deleteRequest = createTestRequest(BASE_URL, { method: "DELETE" });
    const response = await DELETE(deleteRequest);

    expect(response.status).toBe(204);

    // Verify ngrok resources were deleted
    expect(ngrokCalls.deleteCredential).toEqual(["cr_test_456"]);
    expect(ngrokCalls.deleteEndpoint).toEqual(["ep_test_789"]);
    expect(ngrokCalls.deleteReservedDomain).toEqual(["rd_test_abc"]);

    // Verify GET returns 404
    const getResponse = await GET(createTestRequest(BASE_URL));
    expect(getResponse.status).toBe(404);
  });
});

describe("Cross-user isolation", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should not allow user B to see user A's connector", async () => {
    // User A creates connector
    await context.setupUser();
    setupNgrokMocks();
    await POST(createPostRequest());

    // Switch to user B
    await context.setupUser({ prefix: "other-user" });

    // User B should not see it
    const response = await GET(createTestRequest(BASE_URL));
    expect(response.status).toBe(404);
  });

  it("should not allow user B to delete user A's connector", async () => {
    // User A creates connector
    await context.setupUser();
    setupNgrokMocks();
    await POST(createPostRequest());

    // Switch to user B
    await context.setupUser({ prefix: "other-user" });

    // User B should not be able to delete
    const deleteRequest = createTestRequest(BASE_URL, { method: "DELETE" });
    const response = await DELETE(deleteRequest);
    expect(response.status).toBe(404);
  });
});
