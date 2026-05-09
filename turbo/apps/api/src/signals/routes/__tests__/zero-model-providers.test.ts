import { randomUUID } from "node:crypto";

import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteOrgModelProviders$,
  seedOrgModelProvider$,
  type OrgModelProviderFixture,
} from "./helpers/zero-model-providers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/model-providers", () => {
  const track = createFixtureTracker<OrgModelProviderFixture>((fixture) => {
    return store.set(deleteOrgModelProviders$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns empty list when no org providers exist", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    await track(Promise.resolve({ orgId }));

    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.modelProviders).toStrictEqual([]);
  });

  it("lists org providers", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId }));

    await store.set(
      seedOrgModelProvider$,
      {
        orgId,
        type: "anthropic-api-key",
        isDefault: true,
        secretName: "ANTHROPIC_API_KEY",
      },
      context.signal,
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.modelProviders).toHaveLength(1);
    expect(response.body.modelProviders[0]?.type).toBe("anthropic-api-key");
  });

  it("shows first provider as default", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId }));

    await store.set(
      seedOrgModelProvider$,
      {
        orgId,
        type: "anthropic-api-key",
        isDefault: true,
        secretName: "ANTHROPIC_API_KEY",
      },
      context.signal,
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.modelProviders[0]?.isDefault).toBeTruthy();
  });

  it("does not show second same-framework provider as default", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId }));

    await store.set(
      seedOrgModelProvider$,
      {
        orgId,
        type: "anthropic-api-key",
        isDefault: true,
        secretName: "ANTHROPIC_API_KEY",
      },
      context.signal,
    );
    await store.set(
      seedOrgModelProvider$,
      {
        orgId,
        type: "claude-code-oauth-token",
        isDefault: false,
        secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      context.signal,
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const anthropic = response.body.modelProviders.find((provider) => {
      return provider.type === "anthropic-api-key";
    });
    const oauth = response.body.modelProviders.find((provider) => {
      return provider.type === "claude-code-oauth-token";
    });
    expect(anthropic?.isDefault).toBeTruthy();
    expect(oauth?.isDefault).toBeFalsy();
  });

  it("finds default provider for framework via list", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId }));

    await store.set(
      seedOrgModelProvider$,
      {
        orgId,
        type: "anthropic-api-key",
        isDefault: true,
        secretName: "ANTHROPIC_API_KEY",
      },
      context.signal,
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const defaultProvider = response.body.modelProviders.find((provider) => {
      return provider.isDefault && provider.framework === "claude-code";
    });
    expect(defaultProvider).toBeDefined();
    expect(defaultProvider?.type).toBe("anthropic-api-key");
    expect(defaultProvider?.isDefault).toBeTruthy();
  });

  it("has no default for framework when no providers exist", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    await track(Promise.resolve({ orgId }));

    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const defaultProvider = response.body.modelProviders.find((provider) => {
      return provider.isDefault && provider.framework === "claude-code";
    });
    expect(defaultProvider).toBeUndefined();
  });
});
