import { randomUUID } from "node:crypto";

import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { now, nowDate } from "../../external/time";
import { signPatJwtForTests, signSandboxJwtForTests } from "../../auth/tokens";
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

async function seedPatFixture(role: "admin" | "member"): Promise<PatFixture> {
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

  it("resolves PAT bearer auth and returns the org role from cache", async () => {
    const fixture = await seedPatFixture("admin");
    fixtures.push(fixture);

    const client = setupApp({ context, contract: healthAuthProbeContract });
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

  it("resolves sandbox bearer auth", async () => {
    const token = signSandboxJwtForTests({
      scope: "sandbox",
      userId: "user_sandbox",
      orgId: "org_sandbox",
      runId: "run_sandbox",
      iat: currentSecond(),
      exp: currentSecond() + 60,
    });

    const client = setupApp({ context, contract: healthAuthProbeContract });
    const response = await accept(
      client.check({
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

  it("resolves Clerk session auth from a cookie", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => {
        return {
          userId: "user_session_123",
          orgId: "org_session_123",
          orgRole: "org:admin",
        };
      },
    });

    const client = setupApp({ context, contract: healthAuthProbeContract });
    const response = await accept(
      client.check({
        headers: { cookie: "__session=opaque" },
      }),
      [200],
    );

    expect(response.body).toEqual({
      tokenType: "session",
      userId: "user_session_123",
      orgId: "org_session_123",
      orgRole: "admin",
    });
  });

  it("returns 401 for unauthenticated Clerk sessions", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const client = setupApp({ context, contract: healthAuthProbeContract });
    const response = await accept(
      client.check({
        headers: { cookie: "__session=opaque" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("resolves zero bearer auth and includes capabilities", async () => {
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

    const client = setupApp({ context, contract: healthAuthProbeContract });
    const response = await accept(
      client.check({
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

  it("returns 401 when no credentials are presented", async () => {
    const client = setupApp({ context, contract: healthAuthProbeContract });
    const response = await accept(client.check(), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the bearer token is invalid", async () => {
    const client = setupApp({ context, contract: healthAuthProbeContract });
    const response = await accept(
      client.check({
        headers: { authorization: "Bearer vm0_pat_not-a-real-token" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when a PAT user is not a member of the org", async () => {
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

    const client = setupApp({ context, contract: healthAuthProbeContract });
    const response = await accept(
      client.check({
        headers: { authorization: `Bearer ${fixture.token}` },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
