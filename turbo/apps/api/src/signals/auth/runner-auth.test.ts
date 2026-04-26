import { randomUUID } from "node:crypto";

import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { closeFixtureDbPool } from "../../__tests__/db.fixture";
import { honoComputed } from "../context/route";
import { writeDb$ } from "../external/db";
import { now } from "../external/time";
import { runnerAuth$ } from "./runner-auth";
import { signPatJwtForTests, signSandboxJwtForTests } from "./tokens";

function createRunnerAuthApp(): Hono {
  const app = new Hono();
  app.get("/", honoComputed(runnerAuth$, new AbortController().signal));
  return app;
}

const store = createStore();

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
    const response = await createRunnerAuthApp().request("/", {
      headers: {
        authorization:
          "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      },
    });
    const payload: unknown = await response.json();

    expect(payload).toEqual({ type: "official-runner" });
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

    const response = await createRunnerAuthApp().request("/", {
      headers: { authorization: `Bearer ${token}` },
    });
    const payload: unknown = await response.json();

    expect(payload).toEqual({ type: "user", userId });
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

    const response = await createRunnerAuthApp().request("/", {
      headers: { authorization: `Bearer ${token}` },
    });
    const payload: unknown = await response.json();

    expect(payload).toBeNull();
  });
});
