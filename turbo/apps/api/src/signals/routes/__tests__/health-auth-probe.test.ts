import { randomUUID } from "node:crypto";

import { initContract } from "@ts-rest/core";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { computed, createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { authContext$ } from "../../auth/auth-context";
import { authRoute } from "../../auth/auth-route";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { signPatJwtForTests, signSandboxJwtForTests } from "../../auth/tokens";
import { ROUTES } from "../../route";
import { healthAuthProbeContract } from "../health-auth-probe";

interface PatFixture {
  readonly token: string;
  readonly tokenId: string;
  readonly userId: string;
  readonly orgId: string;
}

const store = createStore();
const context = testContext();

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

interface PatFixtureOptions {
  readonly role?: "admin" | "member";
  readonly seedMembership?: boolean;
  readonly cachedAtMs?: number;
  readonly tokenExpiresAtMs?: number;
}

async function seedPatFixture(
  options: PatFixtureOptions = {},
): Promise<PatFixture> {
  const tokenId = randomUUID();
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const nowSeconds = currentSecond();
  const role = options.role ?? "admin";
  const seedMembership = options.seedMembership ?? true;
  const tokenExpiresAtMs = options.tokenExpiresAtMs ?? now() + 60_000;

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
    expiresAt: new Date(tokenExpiresAtMs),
  });
  if (seedMembership) {
    await writeDb.insert(orgMembersCache).values({
      orgId,
      userId,
      role,
      cachedAt: new Date(options.cachedAtMs ?? now()),
    });
  }

  return { token, tokenId, userId, orgId };
}

async function deletePatFixture(fixture: PatFixture): Promise<void> {
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

const c = initContract();

const capabilityProbeContract = c.router({
  check: {
    method: "GET" as const,
    path: "/__test/cap",
    headers: z.object({ authorization: z.string().optional() }),
    responses: {
      200: z.unknown(),
      401: z.object({
        error: z.object({ message: z.string(), code: z.string() }),
      }),
      403: z.object({
        error: z.object({ message: z.string(), code: z.string() }),
      }),
    },
  },
});

const capabilityProbeHandler$ = computed((get) => {
  return { status: 200 as const, body: get(authContext$) };
});

const capabilityProbe$ = authRoute(
  { requiredCapability: "agent:read" },
  capabilityProbeHandler$,
);

describe("GET /health/auth", () => {
  const fixtures: PatFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await deletePatFixture(fixture);
      }
    }
  });

  describe("Clerk session", () => {
    it("resolves admin Clerk session from a cookie", async () => {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: true,
        toAuth: () => {
          return {
            userId: "user_admin",
            orgId: "org_admin",
            orgRole: "org:admin",
          };
        },
      });

      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({ headers: { cookie: "__session=opaque" } }),
        [200],
      );

      expect(response.body).toEqual({
        tokenType: "session",
        userId: "user_admin",
        orgId: "org_admin",
        orgRole: "admin",
      });
    });

    it("maps org:member role to member", async () => {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: true,
        toAuth: () => {
          return {
            userId: "user_member",
            orgId: "org_member",
            orgRole: "org:member",
          };
        },
      });

      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({ headers: { cookie: "__session=opaque" } }),
        [200],
      );

      expect(response.body).toEqual({
        tokenType: "session",
        userId: "user_member",
        orgId: "org_member",
        orgRole: "member",
      });
    });

    it("leaves org fields undefined when not in Clerk session", async () => {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: true,
        toAuth: () => {
          return { userId: "user_solo" };
        },
      });

      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({ headers: { cookie: "__session=opaque" } }),
        [200],
      );

      expect(response.body).toEqual({
        tokenType: "session",
        userId: "user_solo",
      });
    });

    it("returns 401 for unauthenticated Clerk sessions", async () => {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });

      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({ headers: { cookie: "__session=opaque" } }),
        [401],
      );

      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("PAT bearer", () => {
    it("resolves a PAT bearer token with admin role", async () => {
      const fixture = await seedPatFixture({ role: "admin" });
      fixtures.push(fixture);

      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({
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

    it("resolves a PAT bearer token with member role", async () => {
      const fixture = await seedPatFixture({ role: "member" });
      fixtures.push(fixture);

      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({
          headers: { authorization: `Bearer ${fixture.token}` },
        }),
        [200],
      );

      expect(response.body).toEqual({
        userId: fixture.userId,
        orgId: fixture.orgId,
        orgRole: "member",
        tokenType: "pat",
      });
    });

    it("returns 401 when the PAT tokenId is not in the DB", async () => {
      const tokenId = randomUUID();
      const userId = `user_${randomUUID()}`;
      const nowSeconds = currentSecond();
      const token = signPatJwtForTests({
        scope: "cli",
        userId,
        orgId: `org_${randomUUID()}`,
        tokenId,
        iat: nowSeconds,
        exp: nowSeconds + 60,
      });

      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({ headers: { authorization: `Bearer ${token}` } }),
        [401],
      );

      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 when the PAT DB record has expired", async () => {
      const fixture = await seedPatFixture({
        tokenExpiresAtMs: now() - 60_000,
      });
      fixtures.push(fixture);

      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({
          headers: { authorization: `Bearer ${fixture.token}` },
        }),
        [401],
      );

      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 when the PAT user is not a member of the org", async () => {
      const fixture = await seedPatFixture({ seedMembership: false });
      fixtures.push(fixture);
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        { data: [] },
      );

      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({
          headers: { authorization: `Bearer ${fixture.token}` },
        }),
        [401],
      );

      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("org membership cache", () => {
    it("populates the cache from Clerk on cache miss and serves the next request from cache", async () => {
      const fixture = await seedPatFixture({ seedMembership: false });
      fixtures.push(fixture);
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [{ organization: { id: fixture.orgId }, role: "org:admin" }],
        },
      );

      const client = setupApp({ context })(healthAuthProbeContract);

      const first = await accept(
        client.check({
          headers: { authorization: `Bearer ${fixture.token}` },
        }),
        [200],
      );
      expect(first.body).toEqual({
        tokenType: "pat",
        userId: fixture.userId,
        orgId: fixture.orgId,
        orgRole: "admin",
      });

      const callsBefore =
        context.mocks.clerk.users.getOrganizationMembershipList.mock.calls
          .length;

      const second = await accept(
        client.check({
          headers: { authorization: `Bearer ${fixture.token}` },
        }),
        [200],
      );
      expect(second.body).toEqual(first.body);
      expect(
        context.mocks.clerk.users.getOrganizationMembershipList.mock.calls
          .length,
      ).toBe(callsBefore);
    });

    it("refreshes the cached role when Clerk reports a different role", async () => {
      const fixture = await seedPatFixture({
        role: "member",
        cachedAtMs: now() - 5 * 60_000,
      });
      fixtures.push(fixture);
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [{ organization: { id: fixture.orgId }, role: "org:admin" }],
        },
      );

      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({
          headers: { authorization: `Bearer ${fixture.token}` },
        }),
        [200],
      );
      expect(response.body).toEqual({
        tokenType: "pat",
        userId: fixture.userId,
        orgId: fixture.orgId,
        orgRole: "admin",
      });

      const writeDb = store.set(writeDb$);
      const [cached] = await writeDb
        .select({
          role: orgMembersCache.role,
          cachedAt: orgMembersCache.cachedAt,
        })
        .from(orgMembersCache)
        .where(
          and(
            eq(orgMembersCache.orgId, fixture.orgId),
            eq(orgMembersCache.userId, fixture.userId),
          ),
        );
      expect(cached?.role).toBe("admin");
    });

    it("removes a stale cache row when Clerk reports no membership", async () => {
      const fixture = await seedPatFixture({
        role: "admin",
        cachedAtMs: now() - 5 * 60_000,
      });
      fixtures.push(fixture);
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        { data: [] },
      );

      const client = setupApp({ context })(healthAuthProbeContract);
      const first = await accept(
        client.check({
          headers: { authorization: `Bearer ${fixture.token}` },
        }),
        [401],
      );
      expect(first.body.error.code).toBe("UNAUTHORIZED");

      const writeDb = store.set(writeDb$);
      const remaining = await writeDb
        .select({ orgId: orgMembersCache.orgId })
        .from(orgMembersCache)
        .where(
          and(
            eq(orgMembersCache.orgId, fixture.orgId),
            eq(orgMembersCache.userId, fixture.userId),
          ),
        );
      expect(remaining).toHaveLength(0);
    });
  });

  describe("Sandbox bearer", () => {
    it("resolves a sandbox bearer token", async () => {
      const token = signSandboxJwtForTests({
        scope: "sandbox",
        userId: "user_sandbox",
        orgId: "org_sandbox",
        runId: "run_sandbox",
        iat: currentSecond(),
        exp: currentSecond() + 60,
      });

      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({ headers: { authorization: `Bearer ${token}` } }),
        [200],
      );

      expect(response.body).toEqual({
        tokenType: "sandbox",
        userId: "user_sandbox",
        orgId: "org_sandbox",
        runId: "run_sandbox",
      });
    });
  });

  describe("Zero bearer", () => {
    it("resolves a zero bearer token with member orgRole", async () => {
      const fixture = await seedPatFixture({ role: "member" });
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

      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({ headers: { authorization: `Bearer ${token}` } }),
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

    it("resolves a zero bearer token with admin orgRole", async () => {
      const fixture = await seedPatFixture({ role: "admin" });
      fixtures.push(fixture);
      const nowSeconds = currentSecond();
      const token = signSandboxJwtForTests({
        scope: "zero",
        userId: fixture.userId,
        orgId: fixture.orgId,
        runId: "run_zero",
        capabilities: ["file:read", "file:write"],
        iat: nowSeconds,
        exp: nowSeconds + 60,
      });

      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({ headers: { authorization: `Bearer ${token}` } }),
        [200],
      );

      expect(response.body).toEqual({
        userId: fixture.userId,
        orgId: fixture.orgId,
        orgRole: "admin",
        runId: "run_zero",
        capabilities: ["file:read", "file:write"],
        tokenType: "zero",
      });
    });

    it("omits orgRole when the zero user is no longer an org member", async () => {
      const userId = `user_${randomUUID()}`;
      const orgId = `org_${randomUUID()}`;
      const nowSeconds = currentSecond();
      const token = signSandboxJwtForTests({
        scope: "zero",
        userId,
        orgId,
        runId: "run_zero",
        capabilities: ["file:read"],
        iat: nowSeconds,
        exp: nowSeconds + 60,
      });
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        { data: [] },
      );

      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({ headers: { authorization: `Bearer ${token}` } }),
        [200],
      );

      expect(response.body).toEqual({
        userId,
        orgId,
        runId: "run_zero",
        capabilities: ["file:read"],
        tokenType: "zero",
      });
    });
  });

  describe("rejected requests", () => {
    it("returns 401 when no credentials are presented", async () => {
      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(client.check(), [401]);

      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 when the bearer token has an unknown shape", async () => {
      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({
          headers: { authorization: "Bearer vm0_pat_not-a-real-token" },
        }),
        [401],
      );

      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 for a non-Bearer Authorization header without cookie", async () => {
      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({
          headers: { authorization: "Basic dXNlcjpwYXNz" },
        }),
        [401],
      );

      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 when the bearer token has no recognized prefix", async () => {
      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({ headers: { authorization: "Bearer foobar123" } }),
        [401],
      );

      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 for a sandbox-prefixed bearer with an invalid signature", async () => {
      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({
          headers: { authorization: "Bearer vm0_sandbox_not-a-real-token" },
        }),
        [401],
      );

      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 when the Bearer header carries an empty token", async () => {
      const client = setupApp({ context })(healthAuthProbeContract);
      const response = await accept(
        client.check({ headers: { authorization: "Bearer " } }),
        [401],
      );

      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("zero capability check", () => {
    it("accepts a zero token whose capabilities include the required one", async () => {
      const fixture = await seedPatFixture({ role: "admin" });
      fixtures.push(fixture);
      const nowSeconds = currentSecond();
      const token = signSandboxJwtForTests({
        scope: "zero",
        userId: fixture.userId,
        orgId: fixture.orgId,
        runId: "run_zero",
        capabilities: ["agent:read"],
        iat: nowSeconds,
        exp: nowSeconds + 60,
      });

      const client = setupApp({
        context,
        routes: [
          ...ROUTES,
          { route: capabilityProbeContract.check, handler: capabilityProbe$ },
        ],
      })(capabilityProbeContract);
      const response = await accept(
        client.check({ headers: { authorization: `Bearer ${token}` } }),
        [200],
      );

      expect(response.body).toEqual({
        tokenType: "zero",
        userId: fixture.userId,
        orgId: fixture.orgId,
        orgRole: "admin",
        runId: "run_zero",
        capabilities: ["agent:read"],
      });
    });

    it("rejects a zero token whose capabilities omit the required one", async () => {
      const fixture = await seedPatFixture({ role: "admin" });
      fixtures.push(fixture);
      const nowSeconds = currentSecond();
      const token = signSandboxJwtForTests({
        scope: "zero",
        userId: fixture.userId,
        orgId: fixture.orgId,
        runId: "run_zero",
        capabilities: ["agent:write"],
        iat: nowSeconds,
        exp: nowSeconds + 60,
      });

      const client = setupApp({
        context,
        routes: [
          ...ROUTES,
          { route: capabilityProbeContract.check, handler: capabilityProbe$ },
        ],
      })(capabilityProbeContract);
      const response = await accept(
        client.check({ headers: { authorization: `Bearer ${token}` } }),
        [403],
      );

      expect(response.body.error.code).toBe("FORBIDDEN");
    });
  });
});
