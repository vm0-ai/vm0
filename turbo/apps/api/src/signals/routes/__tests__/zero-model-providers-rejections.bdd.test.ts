import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the org model-provider list / upsert / delete auth,
// empty-org, admin-only and not-found rejections. Configuring a real provider
// (upsert success, OAuth refresh state, legacy-row delete) needs a seeded secret
// and stays in the kept legacy. See `api.bdd.md` (CHAIN-MODEL-PROVIDERS-REJECTIONS).
const context = testContext();

const UPSERT_BODY = {
  type: "anthropic-api-key",
  secret: "sk-ant-test",
} as const;

describe("org model provider rejections (API-first BDD)", () => {
  it("list rejects unauthenticated / org-less callers and is empty for a fresh org", async () => {
    const api = createBddApi(context);

    await accept(api.modelProviders.list({ headers: {} }), [401]);

    api.actAsNoOrg();
    await accept(api.modelProviders.list({ headers: SESSION_AUTH }), [401]);

    api.actAsAdmin();
    const empty = await accept(
      api.modelProviders.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body.modelProviders).toStrictEqual([]);
  });

  it("upsert rejects unauthenticated / org-less / non-admin callers", async () => {
    const api = createBddApi(context);

    await accept(
      api.modelProviders.upsert({ body: UPSERT_BODY, headers: {} }),
      [401],
    );

    api.actAsNoOrg();
    await accept(
      api.modelProviders.upsert({ body: UPSERT_BODY, headers: SESSION_AUTH }),
      [401],
    );

    api.actAsMember({ userId: "user_mp_member", orgId: "org_mp" });
    await accept(
      api.modelProviders.upsert({ body: UPSERT_BODY, headers: SESSION_AUTH }),
      [403],
    );
  });

  it("delete rejects unauthenticated / org-less / non-admin callers and 404s an absent provider", async () => {
    const api = createBddApi(context);

    await accept(
      api.modelProvidersByType.delete({
        params: { type: "anthropic-api-key" },
        headers: {},
      }),
      [401],
    );

    api.actAsNoOrg();
    await accept(
      api.modelProvidersByType.delete({
        params: { type: "anthropic-api-key" },
        headers: SESSION_AUTH,
      }),
      [401],
    );

    api.actAsMember({ userId: "user_mp_member", orgId: "org_mp" });
    await accept(
      api.modelProvidersByType.delete({
        params: { type: "anthropic-api-key" },
        headers: SESSION_AUTH,
      }),
      [403],
    );

    // An admin deleting a provider that is not configured.
    api.actAsAdmin();
    const notFound = await accept(
      api.modelProvidersByType.delete({
        params: { type: "anthropic-api-key" },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(notFound.body.error.message).toBe("Resource not found");
  });
});
