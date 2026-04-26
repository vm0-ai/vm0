import { randomUUID } from "node:crypto";

import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { createStore, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { vi } from "vitest";

import { closeFixtureDbPool } from "../../__tests__/db.fixture";
import { honoComputed } from "../context/route";
import { writeDb$ } from "../external/db";
import { now, nowDate } from "../external/time";
import {
  apiKeyAuthContext$,
  createAuthContext$,
  createRequiredAuthContext$,
} from "./auth-context";
import { signPatJwtForTests, signSandboxJwtForTests } from "./tokens";

const clerkClient = vi.hoisted(() => {
  return {
    users: {
      getOrganizationMembershipList: vi.fn(),
    },
  };
});

vi.mock("@clerk/backend", () => {
  return {
    createClerkClient: () => {
      return clerkClient;
    },
  };
});

interface TestTokenFixture {
  readonly token: string;
  readonly tokenId: string;
  readonly userId: string;
  readonly orgId: string;
}

function createAuthApp(result$: Computed<unknown>): Hono {
  const app = new Hono();
  app.get("/", honoComputed(result$, new AbortController().signal));
  return app;
}

const store = createStore();

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

async function seedPatFixture(
  role: "admin" | "member",
): Promise<TestTokenFixture> {
  const tokenId = randomUUID();
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const nowSeconds = currentSecond();
  const token = signPatJwtForTests({
    scope: "cli",
    userId,
    orgId,
    tokenId,
    iat: nowSeconds,
    exp: nowSeconds + 60,
  });
  const writeDb = store.set(writeDb$);

  await writeDb.insert(cliTokens).values({
    id: tokenId,
    token,
    userId,
    name: "test token",
    expiresAt: new Date(now() + 60_000),
  });
  await writeDb.insert(orgMembersCache).values({
    orgId,
    userId,
    role,
    cachedAt: nowDate(),
  });

  return { token, tokenId, userId, orgId };
}

async function deletePatFixture(fixture: TestTokenFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.orgId, fixture.orgId),
        eq(orgMembersCache.userId, fixture.userId),
      ),
    );
  await writeDb.delete(cliTokens).where(eq(cliTokens.id, fixture.tokenId));
}

describe("auth context", () => {
  const fixtures: TestTokenFixture[] = [];

  afterEach(async () => {
    clerkClient.users.getOrganizationMembershipList.mockReset();

    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await deletePatFixture(fixture);
      }
    }
  });

  afterAll(async () => {
    await closeFixtureDbPool();
  });

  it("authenticates PAT bearer tokens and resolves org role from cache", async () => {
    const fixture = await seedPatFixture("admin");
    fixtures.push(fixture);

    const response = await createAuthApp(createAuthContext$()).request("/", {
      headers: { authorization: `Bearer ${fixture.token}` },
    });
    const payload: unknown = await response.json();

    expect(payload).toEqual({
      userId: fixture.userId,
      orgId: fixture.orgId,
      orgRole: "admin",
      tokenType: "pat",
    });
  });

  it("requires PAT tokens for strict API key auth", async () => {
    const token = signSandboxJwtForTests({
      scope: "sandbox",
      userId: "user_sandbox",
      orgId: "org_sandbox",
      runId: "run_sandbox",
      iat: currentSecond(),
      exp: currentSecond() + 60,
    });

    const response = await createAuthApp(apiKeyAuthContext$).request("/", {
      headers: { authorization: `Bearer ${token}` },
    });
    const payload: unknown = await response.json();

    expect(payload).toEqual({
      status: 401,
      body: {
        error: { message: "API key required", code: "UNAUTHORIZED" },
      },
    });
  });

  it("rejects PAT bearer tokens when org membership is missing", async () => {
    const fixture = await seedPatFixture("member");
    fixtures.push(fixture);
    clerkClient.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });
    await store
      .set(writeDb$)
      .delete(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, fixture.orgId),
          eq(orgMembersCache.userId, fixture.userId),
        ),
      );

    const response = await createAuthApp(createAuthContext$()).request("/", {
      headers: { authorization: `Bearer ${fixture.token}` },
    });
    const payload: unknown = await response.json();

    expect(payload).toBeNull();
  });

  it("authenticates sandbox tokens only when explicitly allowed", async () => {
    const token = signSandboxJwtForTests({
      scope: "sandbox",
      userId: "user_sandbox",
      orgId: "org_sandbox",
      runId: "run_sandbox",
      iat: currentSecond(),
      exp: currentSecond() + 60,
    });

    const response = await createAuthApp(
      createAuthContext$({ acceptAnySandboxCapability: true }),
    ).request("/", {
      headers: { authorization: `Bearer ${token}` },
    });
    const payload: unknown = await response.json();

    expect(payload).toEqual({
      tokenType: "sandbox",
      userId: "user_sandbox",
      orgId: "org_sandbox",
      runId: "run_sandbox",
    });
  });

  it("authenticates zero tokens with required capabilities", async () => {
    const fixture = await seedPatFixture("member");
    fixtures.push(fixture);
    const nowSeconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId: "run_zero",
      capabilities: ["file:read"],
      iat: nowSeconds,
      exp: nowSeconds + 60,
    });

    const response = await createAuthApp(
      createAuthContext$({ requiredCapability: "file:read" }),
    ).request("/", {
      headers: { authorization: `Bearer ${token}` },
    });
    const payload: unknown = await response.json();

    expect(payload).toEqual({
      userId: fixture.userId,
      orgId: fixture.orgId,
      orgRole: "member",
      runId: "run_zero",
      capabilities: ["file:read"],
      tokenType: "zero",
    });
  });

  it("returns forbidden for valid zero tokens missing a required capability", async () => {
    const nowSeconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId: "user_zero_missing_cap",
      orgId: "org_zero_missing_cap",
      runId: "run_zero_missing_cap",
      capabilities: ["file:read"],
      iat: nowSeconds,
      exp: nowSeconds + 60,
    });

    const response = await createAuthApp(
      createRequiredAuthContext$({ requiredCapability: "file:write" }),
    ).request("/", {
      headers: { authorization: `Bearer ${token}` },
    });
    const payload: unknown = await response.json();

    expect(payload).toEqual({
      status: 403,
      body: {
        error: {
          message: "Missing required capability: file:write",
          code: "FORBIDDEN",
        },
      },
    });
  });
});
