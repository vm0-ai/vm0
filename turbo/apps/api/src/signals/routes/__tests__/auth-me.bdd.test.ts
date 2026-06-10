import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authContract } from "@vm0/api-contracts/contracts/auth";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";

const NOW_MS = Date.parse("2026-05-12T04:00:00.000Z");
const context = testContext();

interface AuthActor {
  readonly orgId: string;
  readonly userId: string;
}

interface ClerkEmailProfile {
  readonly emailAddresses: readonly {
    readonly emailAddress: string;
    readonly id: string;
  }[];
  readonly firstName: string | null;
  readonly id: string;
  readonly lastName: string | null;
  readonly primaryEmailAddressId: string | null;
}

function apiClient() {
  return setupApp({ context })(authContract);
}

function actor(prefix: string): AuthActor {
  const suffix = randomUUID().slice(0, 8);
  return {
    orgId: `org_${prefix}_${suffix}`,
    userId: `user_${prefix}_${suffix}`,
  };
}

function authHeaders(token = "clerk-session"): {
  readonly authorization: string;
} {
  return { authorization: `Bearer ${token}` };
}

function currentSecond(): number {
  return Math.floor(NOW_MS / 1000);
}

function clerkUser(
  userId: string,
  email: string,
  name: { readonly firstName?: string; readonly lastName?: string } = {},
): ClerkEmailProfile {
  const emailId = `email_${userId}`;
  return {
    id: userId,
    firstName: name.firstName ?? null,
    lastName: name.lastName ?? null,
    emailAddresses: [{ id: emailId, emailAddress: email }],
    primaryEmailAddressId: emailId,
  };
}

function mockClerkUser(
  userId: string,
  email: string,
  name?: { readonly firstName?: string; readonly lastName?: string },
): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [clerkUser(userId, email, name)],
  });
}

function mockSession(member: AuthActor): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return {
        userId: member.userId,
        orgId: member.orgId,
        orgRole: "org:admin",
      };
    },
  });
}

function mockNoMembership(): void {
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [],
  });
}

function sandboxToken(member: AuthActor): string {
  const nowSeconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: member.userId,
    orgId: member.orgId,
    runId: `run_${randomUUID()}`,
    iat: nowSeconds,
    exp: nowSeconds + 60,
  });
}

function zeroToken(
  member: AuthActor,
  capabilities: readonly ZeroCapability[],
): string {
  const nowSeconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: member.userId,
    orgId: member.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: [...capabilities],
    iat: nowSeconds,
    exp: nowSeconds + 60,
  });
}

beforeEach(() => {
  mockNow(NOW_MS);
});

afterEach(() => {
  clearMockNow();
});

describe("/api/auth/me BDD", () => {
  it("rejects unauthenticated requests", async () => {
    const response = await accept(apiClient().me({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns the current Clerk session email", async () => {
    const member = actor("session");
    mockSession(member);
    mockClerkUser(member.userId, "test@example.com", {
      firstName: "Test",
      lastName: "User",
    });

    const response = await accept(
      apiClient().me({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      userId: member.userId,
      email: "test@example.com",
    });
  });

  it("accepts sandbox and zero tokens without requiring a specific capability", async () => {
    const sandboxMember = actor("sandbox");
    mockClerkUser(sandboxMember.userId, "sandbox@example.com");

    const sandboxResponse = await accept(
      apiClient().me({
        headers: authHeaders(sandboxToken(sandboxMember)),
      }),
      [200],
    );

    expect(sandboxResponse.body).toStrictEqual({
      userId: sandboxMember.userId,
      email: "sandbox@example.com",
    });

    const fileWriter = actor("zero_file");
    mockNoMembership();
    mockClerkUser(fileWriter.userId, "file@example.com");

    const fileTokenResponse = await accept(
      apiClient().me({
        headers: authHeaders(zeroToken(fileWriter, ["file:write"])),
      }),
      [200],
    );

    expect(fileTokenResponse.body).toStrictEqual({
      userId: fileWriter.userId,
      email: "file@example.com",
    });

    const zeroMember = actor("zero_empty");
    mockNoMembership();
    mockClerkUser(zeroMember.userId, "empty-capabilities@example.com");

    const emptyCapabilitiesResponse = await accept(
      apiClient().me({
        headers: authHeaders(zeroToken(zeroMember, [])),
      }),
      [200],
    );

    expect(emptyCapabilitiesResponse.body).toStrictEqual({
      userId: zeroMember.userId,
      email: "empty-capabilities@example.com",
    });
  });

  it("serves a fresh cached email through the route", async () => {
    const member = actor("fresh_cache");
    const token = sandboxToken(member);
    mockClerkUser(member.userId, "cached@example.com");

    const firstResponse = await accept(
      apiClient().me({ headers: authHeaders(token) }),
      [200],
    );

    expect(firstResponse.body).toStrictEqual({
      userId: member.userId,
      email: "cached@example.com",
    });

    context.mocks.clerk.users.getUserList.mockClear();
    mockClerkUser(member.userId, "changed@example.com");

    const cachedResponse = await accept(
      apiClient().me({ headers: authHeaders(token) }),
      [200],
    );

    expect(cachedResponse.body).toStrictEqual({
      userId: member.userId,
      email: "cached@example.com",
    });
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
  });

  it("refreshes a stale cached email through the route", async () => {
    const member = actor("stale_cache");
    const token = sandboxToken(member);
    mockNow(NOW_MS - 16 * 60 * 1000);
    mockClerkUser(member.userId, "stale@example.com");

    const staleSeedResponse = await accept(
      apiClient().me({ headers: authHeaders(token) }),
      [200],
    );

    expect(staleSeedResponse.body).toStrictEqual({
      userId: member.userId,
      email: "stale@example.com",
    });

    context.mocks.clerk.users.getUserList.mockClear();
    mockNow(NOW_MS);
    mockClerkUser(member.userId, "fresh@example.com");

    const refreshedResponse = await accept(
      apiClient().me({ headers: authHeaders(token) }),
      [200],
    );

    expect(refreshedResponse.body).toStrictEqual({
      userId: member.userId,
      email: "fresh@example.com",
    });
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      userId: [member.userId],
    });
  });
});
