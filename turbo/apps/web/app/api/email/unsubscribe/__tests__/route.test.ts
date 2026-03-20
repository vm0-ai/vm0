import crypto from "crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { POST, GET } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { insertTestUser } from "../../../../../src/__tests__/api-test-helpers";
import { env, reloadEnv } from "../../../../../src/env";

const context = testContext();

/** Generate a valid HMAC-signed unsubscribe token for testing */
function generateToken(userId: string): string {
  const hmac = crypto
    .createHmac("sha256", env().SECRETS_ENCRYPTION_KEY)
    .update(`unsubscribe:${userId}`)
    .digest("hex")
    .slice(0, 32);
  return `${userId}.${hmac}`;
}

function createUnsubscribeRequest(
  method: "GET" | "POST",
  token?: string,
): Request {
  const url = token
    ? `http://localhost:3000/api/email/unsubscribe?token=${encodeURIComponent(token)}`
    : "http://localhost:3000/api/email/unsubscribe";

  return new Request(url, { method });
}

describe("POST /api/email/unsubscribe", () => {
  beforeEach(async () => {
    context.setupMocks();
    reloadEnv();
  });

  it("returns 400 when token is missing", async () => {
    const request = createUnsubscribeRequest("POST");
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Missing token");
  });

  it("returns 400 when token is invalid", async () => {
    const request = createUnsubscribeRequest("POST", "invalid-token");
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Invalid token");
  });

  it("unsubscribes user with valid token", async () => {
    await context.setupUser();
    const userId = uniqueId("unsub-user");
    await insertTestUser(userId);
    const token = generateToken(userId);

    const response = await POST(createUnsubscribeRequest("POST", token));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.unsubscribed).toBe(true);
  });

  it("is idempotent — repeated unsubscribe succeeds", async () => {
    await context.setupUser();
    const userId = uniqueId("unsub-idem");
    const token = generateToken(userId);

    // First unsubscribe
    const response1 = await POST(createUnsubscribeRequest("POST", token));
    expect(response1.status).toBe(200);

    // Second unsubscribe
    const response2 = await POST(createUnsubscribeRequest("POST", token));
    expect(response2.status).toBe(200);
    const data2 = await response2.json();
    expect(data2.unsubscribed).toBe(true);
  });

  it("creates user row when user does not exist", async () => {
    await context.setupUser();
    const userId = uniqueId("new-user");
    const token = generateToken(userId);

    const response = await POST(createUnsubscribeRequest("POST", token));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.unsubscribed).toBe(true);
  });
});

describe("GET /api/email/unsubscribe", () => {
  beforeEach(async () => {
    context.setupMocks();
    reloadEnv();
  });

  it("returns 400 when token is missing", async () => {
    const request = createUnsubscribeRequest("GET");
    const response = await GET(request);

    expect(response.status).toBe(400);
  });

  it("returns 400 when token is invalid", async () => {
    const request = createUnsubscribeRequest("GET", "bad.token");
    const response = await GET(request);

    expect(response.status).toBe(400);
  });

  it("returns HTML confirmation page on success", async () => {
    await context.setupUser();
    const userId = uniqueId("unsub-html");
    const token = generateToken(userId);

    const response = await GET(createUnsubscribeRequest("GET", token));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("You have been unsubscribed");
  });
});
