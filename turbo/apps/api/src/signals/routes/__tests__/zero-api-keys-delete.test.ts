import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { apiKeysByIdContract } from "@vm0/api-contracts/contracts/api-keys";
import { cliTokens } from "@vm0/db/schema/cli-tokens";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteApiKeys$,
  seedApiKeys$,
  type ApiKeysFixture,
} from "./helpers/zero-api-keys";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function seedRow(name: string, suffix: string) {
  return {
    name,
    token: `vm0_pat_${suffix}_${randomUUID().slice(0, 8)}`,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    expiresAt: new Date("2026-04-01T00:00:00.000Z"),
  };
}

describe("DELETE /api/zero/api-keys/:id", () => {
  const track = createFixtureTracker<ApiKeysFixture>((fixture) => {
    return store.set(deleteApiKeys$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(apiKeysByIdContract);
    const response = await accept(
      client.delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("deletes the caller's own key (DB read-after-delete)", async () => {
    const fixture = await track(
      store.set(seedApiKeys$, [seedRow("to delete", "del")], context.signal),
    );
    const tokenId = fixture.tokenIds[0];
    expect(tokenId).toBeDefined();
    mocks.clerk.session(fixture.userId, `org_${randomUUID().slice(0, 8)}`);

    const client = setupApp({ context })(apiKeysByIdContract);
    const response = await accept(
      client.delete({
        params: { id: tokenId! },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    expect(response.body).toBeUndefined();

    // DB read-after-delete: row gone.
    const writeDb = store.set(writeDb$);
    const survivors = await writeDb
      .select()
      .from(cliTokens)
      .where(eq(cliTokens.id, tokenId!));
    expect(survivors).toHaveLength(0);
  });

  it("returns 404 for an unknown id", async () => {
    const fixture = await track(store.set(seedApiKeys$, [], context.signal));
    mocks.clerk.session(fixture.userId, `org_${randomUUID().slice(0, 8)}`);

    const client = setupApp({ context })(apiKeysByIdContract);
    const response = await accept(
      client.delete({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "API key not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 when another user owns the key (no leak)", async () => {
    const victim = await track(
      store.set(
        seedApiKeys$,
        [seedRow("victim's key", "victim")],
        context.signal,
      ),
    );
    const victimTokenId = victim.tokenIds[0];
    expect(victimTokenId).toBeDefined();

    // Authenticate as a different user; victim is unrelated.
    const attackerUserId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(attackerUserId, `org_${randomUUID().slice(0, 8)}`);

    const client = setupApp({ context })(apiKeysByIdContract);
    const response = await accept(
      client.delete({
        params: { id: victimTokenId! },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "API key not found", code: "NOT_FOUND" },
    });

    // No-leak: victim's row physically still exists.
    const writeDb = store.set(writeDb$);
    const [survivor] = await writeDb
      .select()
      .from(cliTokens)
      .where(eq(cliTokens.id, victimTokenId!));
    expect(survivor).toBeDefined();
    expect(survivor?.userId).toBe(victim.userId);
  });
});
