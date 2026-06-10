import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for personal API keys (PATs). The full token is
// returned exactly once by `create`; thereafter only the prefix is observable
// via `list`. See `api.bdd.md` (CHAIN-API-KEY). Exact-timestamp ordering and a
// non-null `lastUsedAt` need controlled clocks / a used token, so that one case
// stays in the legacy file (GAP-APIKEY-TIMESTAMPS).
const context = testContext();

describe("api keys (API-first BDD)", () => {
  it("chain-api-key: creates a PAT once, lists the prefix, then deletes it", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // Then a new user has no API keys.
    const empty = await accept(
      api.apiKeys.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body).toStrictEqual({ apiKeys: [] });

    // When a PAT is created. Then the full token is returned exactly once.
    const created = await accept(
      api.apiKeys.create({
        headers: SESSION_AUTH,
        body: { name: "CI bot", expiresInDays: 90 },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      id: expect.any(String),
      name: "CI bot",
      token: expect.stringMatching(/^vm0_pat_/),
      tokenPrefix: expect.stringMatching(/^vm0_pat_.+…$/),
      lastUsedAt: null,
    });
    expect(created.body.tokenPrefix).toBe(
      `${created.body.token.slice(0, 12)}…`,
    );

    // When a second PAT is created.
    const second = await accept(
      api.apiKeys.create({
        headers: SESSION_AUTH,
        body: { name: "Deploy key", expiresInDays: 30 },
      }),
      [201],
    );

    // Then the list returns both newest-first, exposing only the prefix.
    const listed = await accept(
      api.apiKeys.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(
      listed.body.apiKeys.map((apiKey) => {
        return apiKey.id;
      }),
    ).toStrictEqual([second.body.id, created.body.id]);
    const firstListed = listed.body.apiKeys.find((apiKey) => {
      return apiKey.id === created.body.id;
    });
    expect(firstListed).toStrictEqual({
      id: created.body.id,
      name: "CI bot",
      tokenPrefix: created.body.tokenPrefix,
      createdAt: created.body.createdAt,
      expiresAt: created.body.expiresAt,
      lastUsedAt: null,
    });
    expect(Object.keys(firstListed ?? {})).not.toContain("token");

    // When one key is deleted. Then it disappears from the list.
    await accept(
      api.apiKeyById.delete({
        params: { id: created.body.id },
        headers: SESSION_AUTH,
      }),
      [204],
    );
    const afterDelete = await accept(
      api.apiKeys.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(
      afterDelete.body.apiKeys.map((apiKey) => {
        return apiKey.id;
      }),
    ).toStrictEqual([second.body.id]);

    // When the same key is deleted again. Then it is not found.
    const missing = await accept(
      api.apiKeyById.delete({
        params: { id: created.body.id },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(missing.body.error.message).toBe("API key not found");
  });

  it("validates the create body", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    for (const body of [
      { name: "", expiresInDays: 90 },
      { name: "CI bot", expiresInDays: 0 },
      { name: "CI bot", expiresInDays: 4000 },
    ]) {
      const response = await accept(
        api.apiKeys.create({ headers: SESSION_AUTH, body }),
        [400],
      );
      expect(response.body.error.code).toBe("BAD_REQUEST");
    }
  });

  it("rejects unauthenticated requests and create without an organization", async () => {
    const api = createBddApi(context);
    const id = randomUUID();

    // Unauthenticated requests on every route.
    const list = await accept(api.apiKeys.list({ headers: {} }), [401]);
    expect(list.body.error.code).toBe("UNAUTHORIZED");
    await accept(
      api.apiKeys.create({
        headers: {},
        body: { name: "CI bot", expiresInDays: 90 },
      }),
      [401],
    );
    await accept(api.apiKeyById.delete({ params: { id }, headers: {} }), [401]);

    // Create requires an explicit organization in the session.
    api.actAsNoOrg();
    const noOrg = await accept(
      api.apiKeys.create({
        headers: SESSION_AUTH,
        body: { name: "CI bot", expiresInDays: 90 },
      }),
      [400],
    );
    expect(noOrg.body.error.code).toBe("BAD_REQUEST");
  });
});
