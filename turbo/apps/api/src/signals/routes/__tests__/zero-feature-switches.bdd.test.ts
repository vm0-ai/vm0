import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for per-user feature-switch overrides. Every
// precondition and assertion is a real HTTP request (get / update / delete).
// See `api.bdd.md` (CHAIN-FEATURE-SWITCH).
const context = testContext();

describe("feature switches (API-first BDD)", () => {
  it("chain-feature-switch: creates, merges, overrides, reads, then clears overrides", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // Then a member with no override row gets empty switches.
    const empty = await accept(
      api.featureSwitches.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body).toStrictEqual({ switches: {} });

    // When a switch is set. Then it is created.
    const created = await accept(
      api.featureSwitches.update({
        headers: SESSION_AUTH,
        body: { switches: { dummy: true } },
      }),
      [200],
    );
    expect(created.body).toStrictEqual({ switches: { dummy: true } });

    // When another key is set. Then it merges, preserving untouched keys.
    const merged = await accept(
      api.featureSwitches.update({
        headers: SESSION_AUTH,
        body: { switches: { lab: false } },
      }),
      [200],
    );
    expect(merged.body).toStrictEqual({
      switches: { dummy: true, lab: false },
    });

    // When an existing key is set again. Then its value is overridden.
    const overridden = await accept(
      api.featureSwitches.update({
        headers: SESSION_AUTH,
        body: { switches: { dummy: false } },
      }),
      [200],
    );
    expect(overridden.body).toStrictEqual({
      switches: { dummy: false, lab: false },
    });

    // Then a subsequent GET returns the persisted overrides.
    const read = await accept(
      api.featureSwitches.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(read.body).toStrictEqual({ switches: { dummy: false, lab: false } });

    // When the overrides are cleared. Then GET returns empty again.
    const cleared = await accept(
      api.featureSwitches.delete({ headers: SESSION_AUTH }),
      [200],
    );
    expect(cleared.body).toStrictEqual({ deleted: true });
    const afterClear = await accept(
      api.featureSwitches.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(afterClear.body).toStrictEqual({ switches: {} });
  });

  it("rejects unauthenticated and no-organization requests", async () => {
    const api = createBddApi(context);

    // Unauthenticated requests on every route.
    await accept(api.featureSwitches.get({ headers: {} }), [401]);
    await accept(
      api.featureSwitches.update({ headers: {}, body: { switches: {} } }),
      [401],
    );
    await accept(api.featureSwitches.delete({ headers: {} }), [401]);

    // A session without an active organization.
    api.actAsNoOrg();
    await accept(api.featureSwitches.get({ headers: SESSION_AUTH }), [401]);
    await accept(
      api.featureSwitches.update({
        headers: SESSION_AUTH,
        body: { switches: { dummy: true } },
      }),
      [401],
    );
    await accept(api.featureSwitches.delete({ headers: SESSION_AUTH }), [401]);
  });
});
