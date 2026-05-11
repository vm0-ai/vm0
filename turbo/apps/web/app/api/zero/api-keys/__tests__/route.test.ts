import { describe, it, expect, beforeEach } from "vitest";
import type { ApiKeyItem } from "@vm0/api-contracts/contracts/api-keys";
import { GET, POST } from "../route";
import { DELETE } from "../[id]/route";
import {
  createTestRequest,
  insertTestCliToken,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

const context = testContext();

const LIST_URL = "http://localhost:3000/api/zero/api-keys";
const ITEM_URL = (id: string) => {
  return `http://localhost:3000/api/zero/api-keys/${id}`;
};

function jsonHeaders() {
  return { "Content-Type": "application/json" };
}

async function listApiKeys() {
  const res = await GET(createTestRequest(LIST_URL, { method: "GET" }));
  expect(res.status).toBe(200);
  return (await res.json()).apiKeys as ApiKeyItem[];
}

async function seedApiKey({
  userId,
  name,
  tokenLabel,
  createdAt,
  lastUsedAt,
}: {
  userId: string;
  name: string;
  tokenLabel: string;
  createdAt: Date;
  lastUsedAt?: Date;
}) {
  const token = `vm0_pat_${tokenLabel}_${randomUUID()}`;

  return insertTestCliToken({
    token,
    userId,
    name,
    createdAt,
    expiresAt: new Date("2026-04-01T00:00:00.000Z"),
    lastUsedAt,
  });
}

describe("GET /api/zero/api-keys", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const res = await GET(createTestRequest(LIST_URL, { method: "GET" }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns empty list for a user with no keys", async () => {
    const res = await GET(createTestRequest(LIST_URL, { method: "GET" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apiKeys).toEqual([]);
  });

  it("returns only the current user's API keys sorted by creation time", async () => {
    const other = await context.setupUser({ prefix: "other-api-key-user" });
    await seedApiKey({
      userId: other.userId,
      name: "Other user",
      tokenLabel: "other",
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
    });

    mockClerk({ userId: user.userId, orgId: user.orgId, orgRole: "org:admin" });
    const older = await seedApiKey({
      userId: user.userId,
      name: "Older",
      tokenLabel: "older",
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    const newer = await seedApiKey({
      userId: user.userId,
      name: "Newer",
      tokenLabel: "newer",
      createdAt: new Date("2026-03-02T00:00:00.000Z"),
      lastUsedAt: new Date("2026-03-03T00:00:00.000Z"),
    });

    const keys = await listApiKeys();

    expect(keys).toStrictEqual([
      {
        id: newer.id,
        name: "Newer",
        tokenPrefix: "vm0_pat_newe\u2026",
        createdAt: "2026-03-02T00:00:00.000Z",
        expiresAt: "2026-04-01T00:00:00.000Z",
        lastUsedAt: "2026-03-03T00:00:00.000Z",
      },
      {
        id: older.id,
        name: "Older",
        tokenPrefix: "vm0_pat_olde\u2026",
        createdAt: "2026-03-01T00:00:00.000Z",
        expiresAt: "2026-04-01T00:00:00.000Z",
        lastUsedAt: null,
      },
    ]);
  });
});

describe("POST /api/zero/api-keys", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("creates a new PAT and returns the full token exactly once", async () => {
    const res = await POST(
      createTestRequest(LIST_URL, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "CI bot", expiresInDays: 90 }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toMatch(/^vm0_pat_/);
    expect(body.name).toBe("CI bot");
    expect(body.tokenPrefix.length).toBeGreaterThan(8);
    expect(body.id).toBeDefined();
    expect(body.createdAt).toBeDefined();
    expect(body.expiresAt).toBeDefined();
    expect(body.lastUsedAt).toBeNull();

    // Verify via list endpoint — source of truth for persisted state.
    const keys = await listApiKeys();
    const found = keys.find((k) => {
      return k.id === body.id;
    });
    expect(found).toBeDefined();
    expect(found?.name).toBe("CI bot");
  });

  it("rejects empty name", async () => {
    const res = await POST(
      createTestRequest(LIST_URL, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "", expiresInDays: 90 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects non-positive expiresInDays", async () => {
    const res = await POST(
      createTestRequest(LIST_URL, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "x", expiresInDays: 0 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects expiresInDays above the 10-year cap", async () => {
    const res = await POST(
      createTestRequest(LIST_URL, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "x", expiresInDays: 4000 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("list excludes the full token and only exposes the prefix", async () => {
    const createRes = await POST(
      createTestRequest(LIST_URL, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "Deploy key", expiresInDays: 30 }),
      }),
    );
    const created = await createRes.json();

    const keys = await listApiKeys();
    const found = keys.find((k) => {
      return k.id === created.id;
    }) as (typeof keys)[number] & { token?: string; tokenPrefix?: string };
    expect(found).toBeDefined();
    expect(found.token).toBeUndefined();
    expect(found.tokenPrefix).toBeDefined();
  });
});

describe("DELETE /api/zero/api-keys/:id", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const delRes = await DELETE(
      createTestRequest(ITEM_URL(randomUUID()), { method: "DELETE" }),
    );

    expect(delRes.status).toBe(401);
    await expect(delRes.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("deletes the caller's own key and returns 204", async () => {
    const createRes = await POST(
      createTestRequest(LIST_URL, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "to delete", expiresInDays: 30 }),
      }),
    );
    const created = await createRes.json();

    const delRes = await DELETE(
      createTestRequest(ITEM_URL(created.id), { method: "DELETE" }),
    );
    expect(delRes.status).toBe(204);

    const keys = await listApiKeys();
    expect(
      keys.find((k) => {
        return k.id === created.id;
      }),
    ).toBeUndefined();
  });

  it("returns 404 for unknown id", async () => {
    const delRes = await DELETE(
      createTestRequest(ITEM_URL(randomUUID()), { method: "DELETE" }),
    );
    expect(delRes.status).toBe(404);
    await expect(delRes.json()).resolves.toStrictEqual({
      error: { message: "API key not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 when another user owns the key", async () => {
    const other = await context.setupUser({ prefix: "other-user" });
    // `other` is now the active session — create a key under `other`.
    const createRes = await POST(
      createTestRequest(LIST_URL, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "other's key", expiresInDays: 30 }),
      }),
    );
    const created = await createRes.json();

    // Switch back to the original user and try to delete `other`'s key.
    mockClerk({ userId: user.userId, orgId: user.orgId, orgRole: "org:admin" });

    const delRes = await DELETE(
      createTestRequest(ITEM_URL(created.id), { method: "DELETE" }),
    );
    expect(delRes.status).toBe(404);
    await expect(delRes.json()).resolves.toStrictEqual({
      error: { message: "API key not found", code: "NOT_FOUND" },
    });

    // The key still exists for `other`.
    mockClerk({
      userId: other.userId,
      orgId: other.orgId,
      orgRole: "org:admin",
    });
    const keys = await listApiKeys();
    expect(
      keys.find((k) => {
        return k.id === created.id;
      }),
    ).toBeDefined();
  });
});
