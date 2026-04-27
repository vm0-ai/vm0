import { randomUUID } from "node:crypto";

import { initContract } from "@ts-rest/core";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { computed, createStore, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { closeFixtureDbPool } from "../../../__tests__/db.fixture";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { now, nowDate } from "../../external/time";
import { contractRoute } from "../../route";
import {
  apiKeyAuthContext$,
  createAuthContext$,
  createRequiredAuthContext$,
} from "../auth-context";
import { signPatJwtForTests, signSandboxJwtForTests } from "../tokens";

interface TestTokenFixture {
  readonly token: string;
  readonly tokenId: string;
  readonly userId: string;
  readonly orgId: string;
}

const store = createStore();
const context = testContext();
const c = initContract();

const authContextTestContract = c.router({
  get: {
    method: "GET",
    path: "/__test/auth-context",
    headers: z.object({
      authorization: z.string().optional(),
    }),
    responses: {
      200: z.unknown(),
      401: z.object({
        error: z.object({
          message: z.string(),
          code: z.literal("UNAUTHORIZED"),
        }),
      }),
      403: z.object({
        error: z.object({
          message: z.string(),
          code: z.literal("FORBIDDEN"),
        }),
      }),
    },
  },
});

type AuthContextTestRouteResponse =
  | { readonly status: 200; readonly body: unknown }
  | {
      readonly status: 401;
      readonly body: {
        readonly error: {
          readonly message: string;
          readonly code: "UNAUTHORIZED";
        };
      };
    }
  | {
      readonly status: 403;
      readonly body: {
        readonly error: {
          readonly message: string;
          readonly code: "FORBIDDEN";
        };
      };
    };

function isAuthErrorResponse(
  value: unknown,
): value is Exclude<AuthContextTestRouteResponse, { readonly status: 200 }> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("status" in value) || !("body" in value)) {
    return false;
  }

  return value.status === 401 || value.status === 403;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function createAuthClient(result$: Computed<unknown>) {
  const handler$ = computed(
    async (get): Promise<AuthContextTestRouteResponse> => {
      const result = await get(result$);
      return isAuthErrorResponse(result)
        ? result
        : { status: 200 as const, body: result };
    },
  );

  return setupApp({
    context,
    contract: authContextTestContract,
    routesExtend: [
      contractRoute({
        contract: authContextTestContract.get,
        handler: handler$,
      }),
    ],
  });
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

    const client = createAuthClient(createAuthContext$());
    const response = await accept(
      client.get({
        headers: { authorization: `Bearer ${fixture.token}` },
      }),
      [200],
    );

    expect(response.body).toEqual({
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

    const client = createAuthClient(apiKeyAuthContext$);
    const response = await accept(
      client.get({
        headers: { authorization: `Bearer ${token}` },
      }),
      [401],
    );

    expect(response.body).toEqual({
      error: { message: "API key required", code: "UNAUTHORIZED" },
    });
  });

  it("rejects PAT bearer tokens when org membership is missing", async () => {
    const fixture = await seedPatFixture("member");
    fixtures.push(fixture);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
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

    const client = createAuthClient(createAuthContext$());
    const response = await accept(
      client.get({
        headers: { authorization: `Bearer ${fixture.token}` },
      }),
      [200],
    );

    expect(response.body).toBeNull();
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

    const client = createAuthClient(
      createAuthContext$({ acceptAnySandboxCapability: true }),
    );
    const response = await accept(
      client.get({
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toEqual({
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

    const client = createAuthClient(
      createAuthContext$({ requiredCapability: "file:read" }),
    );
    const response = await accept(
      client.get({
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toEqual({
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

    const client = createAuthClient(
      createRequiredAuthContext$({ requiredCapability: "file:write" }),
    );
    const response = await accept(
      client.get({
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body).toEqual({
      error: {
        message: "Missing required capability: file:write",
        code: "FORBIDDEN",
      },
    });
  });
});
