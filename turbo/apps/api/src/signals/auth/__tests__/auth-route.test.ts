import { randomUUID } from "node:crypto";

import { initContract } from "@ts-rest/core";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { command, computed, createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { closeFixtureDbPool } from "../../../__tests__/db.fixture";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { now, nowDate } from "../../external/time";
import { clearAllDetached } from "../../utils";
import { authContext$ } from "../auth-context";
import { authRoute } from "../auth-route";
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

const authRouteTestContract = c.router({
  get: {
    method: "GET",
    path: "/__test/auth-route",
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

async function loadCliToken(
  tokenId: string,
): Promise<{ lastUsedAt: Date | null } | undefined> {
  const writeDb = store.set(writeDb$);
  const [record] = await writeDb
    .select({ lastUsedAt: cliTokens.lastUsedAt })
    .from(cliTokens)
    .where(eq(cliTokens.id, tokenId))
    .limit(1);
  return record;
}

describe("authRoute", () => {
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

  it("invokes the inner handler with authContext$ accessible", async () => {
    const fixture = await seedPatFixture("admin");
    fixtures.push(fixture);

    const handler$ = computed((get) => {
      const ctx = get(authContext$);
      return { status: 200 as const, body: ctx };
    });

    const client = setupApp({
      context,
      contract: authRouteTestContract,
      handlers: { get: authRoute({}, handler$) },
    });
    const response = await accept(
      client.get({
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
  });

  it("returns 401 when no credentials are presented", async () => {
    const handler$ = computed(() => {
      return { status: 200 as const, body: { ok: true } };
    });

    const client = setupApp({
      context,
      contract: authRouteTestContract,
      handlers: { get: authRoute({}, handler$) },
    });
    const response = await accept(client.get(), [401]);

    expect(response.body).toEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 when sandbox token lacks the required capability", async () => {
    const token = signSandboxJwtForTests({
      scope: "sandbox",
      userId: "user_sandbox",
      orgId: "org_sandbox",
      runId: "run_sandbox",
      iat: currentSecond(),
      exp: currentSecond() + 60,
    });

    const handler$ = computed(() => {
      return { status: 200 as const, body: { ok: true } };
    });

    const client = setupApp({
      context,
      contract: authRouteTestContract,
      handlers: {
        get: authRoute({ requiredCapability: "file:read" }, handler$),
      },
    });
    const response = await accept(
      client.get({ headers: { authorization: `Bearer ${token}` } }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects credential types not in accept list with 403", async () => {
    const fixture = await seedPatFixture("member");
    fixtures.push(fixture);

    const handler$ = computed(() => {
      return { status: 200 as const, body: { ok: true } };
    });

    const client = setupApp({
      context,
      contract: authRouteTestContract,
      handlers: {
        get: authRoute({ accept: ["session"] }, handler$),
      },
    });
    const response = await accept(
      client.get({
        headers: { authorization: `Bearer ${fixture.token}` },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("supports a Command inner handler with the abort signal", async () => {
    const fixture = await seedPatFixture("member");
    fixtures.push(fixture);

    const handler$ = command((_visitor, _signal: AbortSignal) => {
      return { status: 200 as const, body: { resolved: true } };
    });

    const client = setupApp({
      context,
      contract: authRouteTestContract,
      handlers: { get: authRoute({}, handler$) },
    });
    const response = await accept(
      client.get({
        headers: { authorization: `Bearer ${fixture.token}` },
      }),
      [200],
    );

    expect(response.body).toEqual({ resolved: true });
  });

  it("updates lastUsedAt on the cli token after PAT auth", async () => {
    const fixture = await seedPatFixture("member");
    fixtures.push(fixture);

    expect((await loadCliToken(fixture.tokenId))?.lastUsedAt).toBeNull();

    const handler$ = computed(() => {
      return { status: 200 as const, body: { ok: true } };
    });

    const client = setupApp({
      context,
      contract: authRouteTestContract,
      handlers: { get: authRoute({}, handler$) },
    });
    await accept(
      client.get({
        headers: { authorization: `Bearer ${fixture.token}` },
      }),
      [200],
    );

    await clearAllDetached();

    const after = await loadCliToken(fixture.tokenId);
    expect(after?.lastUsedAt).not.toBeNull();
  });
});
