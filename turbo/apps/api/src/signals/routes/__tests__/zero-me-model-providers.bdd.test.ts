import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the personal model-provider delete route, built
// from a real upsert → list → delete chain. The provider secret is never
// returned by the API. The upsert handler (codex/OAuth auth.json + JWT parsing,
// multi-secret, encrypted storage) and the list registry filter for non-simple
// provider types keep their dedicated legacy tests — see `api.bdd.md`
// (CHAIN-PERSONAL-MODEL-PROVIDER, GAP-CODEX-UPSERT).
const context = testContext();

describe("personal model providers (API-first BDD)", () => {
  it("chain-personal-model-provider: upserts, lists, then deletes a provider", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // Then a new user has no personal providers.
    const empty = await accept(
      api.personalModelProviders.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body.modelProviders).toStrictEqual([]);

    // When a single-secret provider is upserted. Then it is created.
    const created = await accept(
      api.personalModelProviders.upsert({
        headers: SESSION_AUTH,
        body: { type: "claude-code-oauth-token", secret: "sk-ant-test" },
      }),
      [201],
    );
    expect(created.body.created).toBeTruthy();
    expect(created.body.provider).toMatchObject({
      type: "claude-code-oauth-token",
      isDefault: false,
    });

    // Then it appears in the list (metadata only, never the secret).
    const listed = await accept(
      api.personalModelProviders.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(
      listed.body.modelProviders.map((provider) => {
        return provider.type;
      }),
    ).toStrictEqual(["claude-code-oauth-token"]);
    for (const provider of listed.body.modelProviders) {
      expect(provider).not.toHaveProperty("secret");
    }

    // When it is deleted. Then it disappears from the list.
    await accept(
      api.personalModelProviderByType.delete({
        params: { type: "claude-code-oauth-token" },
        headers: SESSION_AUTH,
      }),
      [204],
    );
    const afterDelete = await accept(
      api.personalModelProviders.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(afterDelete.body.modelProviders).toStrictEqual([]);

    // When the same provider is deleted again. Then it is not found.
    const missing = await accept(
      api.personalModelProviderByType.delete({
        params: { type: "claude-code-oauth-token" },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(missing.body.error.message).toBe("Resource not found");
  });

  it("rejects unauthenticated and no-organization requests", async () => {
    const api = createBddApi(context);

    // Unauthenticated requests on list and delete.
    await accept(api.personalModelProviders.list({ headers: {} }), [401]);
    await accept(
      api.personalModelProviderByType.delete({
        params: { type: "anthropic-api-key" },
        headers: {},
      }),
      [401],
    );

    // A session without an active organization.
    api.actAsNoOrg();
    await accept(
      api.personalModelProviders.list({ headers: SESSION_AUTH }),
      [401],
    );
    await accept(
      api.personalModelProviderByType.delete({
        params: { type: "anthropic-api-key" },
        headers: SESSION_AUTH,
      }),
      [401],
    );
  });
});
