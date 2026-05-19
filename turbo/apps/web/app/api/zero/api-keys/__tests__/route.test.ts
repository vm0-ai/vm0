import { randomUUID } from "node:crypto";

import { describe, it, expect, beforeEach } from "vitest";
import { DELETE } from "../[id]/route";
import {
  createTestRequest,
  findTestCliToken,
  insertTestCliToken,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

const ITEM_URL = (id: string) => {
  return `http://localhost:3000/api/zero/api-keys/${id}`;
};

async function seedApiKey({
  userId,
  name,
  tokenLabel,
}: {
  userId: string;
  name: string;
  tokenLabel: string;
}) {
  const token = `vm0_pat_${tokenLabel}_${randomUUID()}`;

  return insertTestCliToken({
    token,
    userId,
    name,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    expiresAt: new Date("2026-04-01T00:00:00.000Z"),
  });
}

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
    const created = await seedApiKey({
      userId: user.userId,
      name: "to delete",
      tokenLabel: "delete",
    });

    const delRes = await DELETE(
      createTestRequest(ITEM_URL(created.id), { method: "DELETE" }),
    );
    expect(delRes.status).toBe(204);

    await expect(findTestCliToken(created.token)).resolves.toBeUndefined();
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
    const created = await seedApiKey({
      userId: other.userId,
      name: "other's key",
      tokenLabel: "other",
    });

    mockClerk({ userId: user.userId, orgId: user.orgId, orgRole: "org:admin" });

    const delRes = await DELETE(
      createTestRequest(ITEM_URL(created.id), { method: "DELETE" }),
    );
    expect(delRes.status).toBe(404);
    await expect(delRes.json()).resolves.toStrictEqual({
      error: { message: "API key not found", code: "NOT_FOUND" },
    });

    const survivor = await findTestCliToken(created.token);
    expect(survivor).toBeDefined();
    expect(survivor?.userId).toBe(other.userId);
  });
});
