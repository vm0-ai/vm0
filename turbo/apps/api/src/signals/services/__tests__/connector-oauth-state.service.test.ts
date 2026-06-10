import { randomUUID } from "node:crypto";

import type { AuthGrantConnectorType } from "@vm0/connectors/connectors";
import { connectorOauthStates } from "@vm0/db/schema/connector-oauth-state";
import { createStore } from "ccstate";
import { inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { writeDb$ } from "../../external/db";
import { nowDate } from "../../external/time";
import { claimConnectorOAuthState } from "../connector-oauth-state.service";

const store = createStore();

type SeedOAuthStateInput = {
  readonly state?: string;
  readonly type?: AuthGrantConnectorType;
  readonly consumedAt?: Date | null;
  readonly expiresAt?: Date;
};

describe("connector OAuth state claim", () => {
  const states = new Set<string>();

  async function seedOAuthState(args: SeedOAuthStateInput = {}) {
    const db = store.set(writeDb$);
    const state = args.state ?? `state-${randomUUID()}`;
    states.add(state);

    const [row] = await db
      .insert(connectorOauthStates)
      .values({
        state,
        type: args.type ?? "github",
        authMethod: "oauth",
        userId: `user_${randomUUID()}`,
        orgId: `org_${randomUUID()}`,
        redirectUri: "https://app.vm0.test/api/connectors/github/callback",
        consumedAt: args.consumedAt,
        expiresAt:
          args.expiresAt ?? new Date(nowDate().getTime() + 15 * 60 * 1000),
      })
      .returning();

    expect(row).toBeDefined();
    return row!;
  }

  afterEach(async () => {
    if (states.size === 0) {
      return;
    }

    const db = store.set(writeDb$);
    await db
      .delete(connectorOauthStates)
      .where(inArray(connectorOauthStates.state, [...states]));
    states.clear();
  });

  it("claims a valid stored state", async () => {
    const row = await seedOAuthState();
    const db = store.set(writeDb$);

    const result = await claimConnectorOAuthState(
      db,
      { state: row.state, connectorType: "github" },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      kind: "usable",
      state: {
        id: row.id,
        state: row.state,
        type: "github",
        authMethod: "oauth",
      },
    });
    if (result.kind === "usable") {
      expect(result.state.consumedAt).toBeInstanceOf(Date);
    }
  });

  it("rejects a stored state after it has already been claimed", async () => {
    const row = await seedOAuthState();
    const db = store.set(writeDb$);
    const signal = new AbortController().signal;

    await expect(
      claimConnectorOAuthState(
        db,
        { state: row.state, connectorType: "github" },
        signal,
      ),
    ).resolves.toMatchObject({ kind: "usable" });
    await expect(
      claimConnectorOAuthState(
        db,
        { state: row.state, connectorType: "github" },
        signal,
      ),
    ).resolves.toStrictEqual({ kind: "invalid" });
  });

  it("allows only one concurrent claim for a stored state", async () => {
    const row = await seedOAuthState();
    const db = store.set(writeDb$);
    const signal = new AbortController().signal;

    const results = await Promise.all([
      claimConnectorOAuthState(
        db,
        { state: row.state, connectorType: "github" },
        signal,
      ),
      claimConnectorOAuthState(
        db,
        { state: row.state, connectorType: "github" },
        signal,
      ),
    ]);

    expect(
      results.filter((result) => {
        return result.kind === "usable";
      }),
    ).toHaveLength(1);
    expect(
      results.filter((result) => {
        return result.kind === "invalid";
      }),
    ).toHaveLength(1);
  });

  it("rejects an expired stored state", async () => {
    const row = await seedOAuthState({
      expiresAt: new Date(nowDate().getTime() - 1000),
    });
    const db = store.set(writeDb$);

    await expect(
      claimConnectorOAuthState(
        db,
        { state: row.state, connectorType: "github" },
        new AbortController().signal,
      ),
    ).resolves.toStrictEqual({ kind: "invalid" });
  });

  it("rejects an already consumed stored state", async () => {
    const row = await seedOAuthState({ consumedAt: nowDate() });
    const db = store.set(writeDb$);

    await expect(
      claimConnectorOAuthState(
        db,
        { state: row.state, connectorType: "github" },
        new AbortController().signal,
      ),
    ).resolves.toStrictEqual({ kind: "invalid" });
  });

  it("rejects a stored state for another connector type", async () => {
    const row = await seedOAuthState({ type: "slack" });
    const db = store.set(writeDb$);

    await expect(
      claimConnectorOAuthState(
        db,
        { state: row.state, connectorType: "github" },
        new AbortController().signal,
      ),
    ).resolves.toStrictEqual({ kind: "invalid" });
  });

  it("returns missing when no stored state exists", async () => {
    const db = store.set(writeDb$);

    await expect(
      claimConnectorOAuthState(
        db,
        { state: `state-${randomUUID()}`, connectorType: "github" },
        new AbortController().signal,
      ),
    ).resolves.toStrictEqual({ kind: "missing" });
  });
});
