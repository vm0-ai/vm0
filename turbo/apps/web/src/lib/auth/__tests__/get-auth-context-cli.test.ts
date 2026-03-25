import { describe, it, expect, beforeEach, vi } from "vitest";
import { auth } from "@clerk/nextjs/server";
import { getAuthContext } from "../get-auth-context";
import { generateCliToken } from "../sandbox-token";
import {
  createTestCliToken,
  deleteTestCliToken,
  findTestCliToken,
} from "../../../__tests__/api-test-helpers";
import { testContext, type UserContext } from "../../../__tests__/test-helpers";

const context = testContext();

describe("getAuthContext with CLI JWT", () => {
  const mockAuth = vi.mocked(auth);
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    mockAuth.mockResolvedValue({
      userId: null,
    } as Awaited<ReturnType<typeof auth>>);
  });

  it("should return auth context for valid CLI JWT", async () => {
    const token = await createTestCliToken(user.userId);

    const result = await getAuthContext(`Bearer ${token}`);

    expect(result).not.toBeNull();
    expect(result?.userId).toBe(user.userId);
    expect(result?.orgId).toBe("org_test_default");
    expect(result?.capabilities).toBeUndefined();
    expect(result?.runId).toBeUndefined();
  });

  it("should accept CLI JWT even with requiredCapability option", async () => {
    const token = await createTestCliToken(user.userId, undefined, user.orgId);

    const result = await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "agent:read",
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe(user.userId);
    expect(result?.orgId).toBe(user.orgId);
  });

  it("should return null for CLI JWT with revoked token (deleted from DB)", async () => {
    const token = await createTestCliToken(user.userId);

    // Simulate revocation by deleting the token record
    await deleteTestCliToken(token);

    const result = await getAuthContext(`Bearer ${token}`);

    expect(result).toBeNull();
  });

  it("should return null for CLI JWT with expired DB record", async () => {
    const token = await createTestCliToken(
      user.userId,
      new Date(Date.now() - 1000),
    );

    const result = await getAuthContext(`Bearer ${token}`);

    expect(result).toBeNull();
  });

  it("should not call Clerk auth() for CLI JWT", async () => {
    const token = await createTestCliToken(user.userId);

    await getAuthContext(`Bearer ${token}`);

    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("should update lastUsedAt on successful auth", async () => {
    const token = await createTestCliToken(user.userId);

    await getAuthContext(`Bearer ${token}`);

    // Wait for the non-blocking lastUsedAt update to complete
    await vi.waitFor(async () => {
      const record = await findTestCliToken(token);
      expect(record?.lastUsedAt).not.toBeNull();
    });
  });

  it("should return null for CLI JWT with non-existent tokenId", async () => {
    const token = await generateCliToken(
      user.userId,
      user.orgId,
      "00000000-0000-0000-0000-000000000000",
    );

    const result = await getAuthContext(`Bearer ${token}`);

    expect(result).toBeNull();
  });
});
