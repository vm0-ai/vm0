import type { UpdateUserModelPreferenceRequest } from "@vm0/api-contracts/contracts/zero-user-model-preference";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the per-member model-first preference. A fresh org
// is provisioned with the default model policies (which include
// `claude-sonnet-4-6`), so a configured model is reachable without any seeding;
// `gpt-5.4` is a supported-but-unconfigured model and `claude-haiku-4-5` is a
// removed model outside the contract enum. See `api.bdd.md`
// (CHAIN-USER-MODEL-PREFERENCE).
const context = testContext();

describe("user model preference (API-first BDD)", () => {
  it("chain-user-model-preference: defaults to null, pins a configured model, then clears", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // Then a member with no preference reads null defaults.
    const initial = await accept(
      api.userModelPreference.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(initial.body).toStrictEqual({
      selectedModel: null,
      updatedAt: null,
    });

    // When a configured model is pinned. Then it is returned and persisted.
    const pinned = await accept(
      api.userModelPreference.update({
        headers: SESSION_AUTH,
        body: { selectedModel: "claude-sonnet-4-6" },
      }),
      [200],
    );
    expect(pinned.body.selectedModel).toBe("claude-sonnet-4-6");
    expect(pinned.body.updatedAt).toStrictEqual(expect.any(String));
    const afterPin = await accept(
      api.userModelPreference.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(afterPin.body).toStrictEqual(pinned.body);

    // When the preference is cleared. Then it reads null again.
    const cleared = await accept(
      api.userModelPreference.update({
        headers: SESSION_AUTH,
        body: { selectedModel: null },
      }),
      [200],
    );
    expect(cleared.body.selectedModel).toBeNull();
    const afterClear = await accept(
      api.userModelPreference.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(afterClear.body.selectedModel).toBeNull();
  });

  it("rejects unconfigured models, malformed bodies, and never persists them", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // A supported model that is not configured for the org is a bad request.
    const unconfigured = await accept(
      api.userModelPreference.update({
        headers: SESSION_AUTH,
        body: { selectedModel: "gpt-5.4" },
      }),
      [400],
    );
    expect(unconfigured.body.error).toStrictEqual({
      message: "Invalid request",
      code: "BAD_REQUEST",
    });

    // A model outside the contract enum is rejected by request validation. The
    // ts-rest client is typed to the enum, so the body is cast to drive the
    // server-side rejection of a removed model.
    const removedModelBody = {
      selectedModel: "claude-haiku-4-5",
    } as unknown as UpdateUserModelPreferenceRequest;
    const removed = await accept(
      api.userModelPreference.update({
        headers: SESSION_AUTH,
        body: removedModelBody,
      }),
      [400],
    );
    expect(removed.body.error.code).toBe("BAD_REQUEST");

    // Neither rejected request was persisted.
    const unchanged = await accept(
      api.userModelPreference.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(unchanged.body).toStrictEqual({
      selectedModel: null,
      updatedAt: null,
    });
  });

  it("requires an authenticated session with an active organization", async () => {
    const api = createBddApi(context);

    // Unauthenticated on get + update.
    await accept(api.userModelPreference.get({ headers: {} }), [401]);
    await accept(
      api.userModelPreference.update({
        headers: {},
        body: { selectedModel: null },
      }),
      [401],
    );

    // Authenticated but with no active organization.
    api.actAsNoOrg();
    await accept(api.userModelPreference.get({ headers: SESSION_AUTH }), [401]);
    await accept(
      api.userModelPreference.update({
        headers: SESSION_AUTH,
        body: { selectedModel: "claude-sonnet-4-6" },
      }),
      [401],
    );
  });
});
