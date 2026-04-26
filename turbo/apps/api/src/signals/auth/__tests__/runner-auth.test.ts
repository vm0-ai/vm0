import { randomUUID } from "node:crypto";

import { initContract } from "@ts-rest/core";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { computed, createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { closeFixtureDbPool } from "../../../__tests__/db.fixture";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { contractRoute } from "../../route";
import { runnerAuth$ } from "../runner-auth";
import { signPatJwtForTests, signSandboxJwtForTests } from "../tokens";

const store = createStore();
const context = testContext();
const c = initContract();

const runnerAuthTestContract = c.router({
  get: {
    method: "GET",
    path: "/__test/runner-auth",
    headers: z.object({
      authorization: z.string().optional(),
    }),
    responses: {
      200: z.union([
        z.object({ type: z.literal("official-runner") }),
        z.object({ type: z.literal("user"), userId: z.string() }),
        z.null(),
      ]),
    },
  },
});

function createRunnerAuthClient() {
  const handler$ = computed(async (get) => {
    return { status: 200 as const, body: await get(runnerAuth$) };
  });

  return setupApp({
    context,
    contract: runnerAuthTestContract,
    routesExtend: [
      contractRoute({
        contract: runnerAuthTestContract.get,
        handler: handler$,
      }),
    ],
  });
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

describe("runnerAuth$", () => {
  const tokenIds: string[] = [];

  afterEach(async () => {
    while (tokenIds.length > 0) {
      const tokenId = tokenIds.pop();
      if (tokenId) {
        await store
          .set(writeDb$)
          .delete(cliTokens)
          .where(eq(cliTokens.id, tokenId));
      }
    }
  });

  afterAll(async () => {
    await closeFixtureDbPool();
  });

  it("authenticates official runner tokens", async () => {
    const client = createRunnerAuthClient();
    const response = await accept(
      client.get({
        headers: {
          authorization:
            "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        },
      }),
      [200],
    );

    expect(response.body).toEqual({ type: "official-runner" });
  });

  it("authenticates user runner PAT tokens through cli_tokens", async () => {
    const tokenId = randomUUID();
    tokenIds.push(tokenId);
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

    await store
      .set(writeDb$)
      .insert(cliTokens)
      .values({
        id: tokenId,
        token,
        userId,
        name: "runner test token",
        expiresAt: new Date(now() + 60_000),
      });

    const client = createRunnerAuthClient();
    const response = await accept(
      client.get({
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toEqual({ type: "user", userId });
  });

  it("rejects non-CLI sandbox tokens", async () => {
    const nowSeconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "sandbox",
      userId: "user_sandbox",
      orgId: "org_sandbox",
      runId: "run_sandbox",
      iat: nowSeconds,
      exp: nowSeconds + 60,
    });

    const client = createRunnerAuthClient();
    const response = await accept(
      client.get({
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toBeNull();
  });
});
