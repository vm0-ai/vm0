import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for per-org-member user preferences. Every
// precondition and assertion is a real HTTP request (get/update). See
// `api.bdd.md` (CHAIN-USER-PREFERENCES).
const context = testContext();

describe("user preferences (API-first BDD)", () => {
  it("chain-user-preferences: returns defaults, then applies full and partial updates", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // Then a member with no metadata row gets defaults.
    const defaults = await accept(
      api.userPreferences.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(defaults.body).toStrictEqual({
      timezone: null,
      pinnedAgentIds: [],
      sendMode: "enter",
      captureNetworkBodiesRemaining: 0,
    });

    // When all fields are set. Then GET returns them.
    await accept(
      api.userPreferences.update({
        headers: SESSION_AUTH,
        body: {
          timezone: "America/Los_Angeles",
          pinnedAgentIds: ["agent_b", "agent_a"],
          sendMode: "cmd-enter",
          captureNetworkBodiesRemaining: 3,
        },
      }),
      [200],
    );
    const all = await accept(
      api.userPreferences.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(all.body).toStrictEqual({
      timezone: "America/Los_Angeles",
      pinnedAgentIds: ["agent_b", "agent_a"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 3,
    });

    // When only the timezone is updated. Then the other fields are preserved.
    await accept(
      api.userPreferences.update({
        headers: SESSION_AUTH,
        body: { timezone: "America/New_York" },
      }),
      [200],
    );
    const afterTimezone = await accept(
      api.userPreferences.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(afterTimezone.body).toStrictEqual({
      timezone: "America/New_York",
      pinnedAgentIds: ["agent_b", "agent_a"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 3,
    });

    // When only pinnedAgentIds is updated. Then the other fields are preserved.
    await accept(
      api.userPreferences.update({
        headers: SESSION_AUTH,
        body: { pinnedAgentIds: ["agent_c"] },
      }),
      [200],
    );
    const afterPins = await accept(
      api.userPreferences.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(afterPins.body).toStrictEqual({
      timezone: "America/New_York",
      pinnedAgentIds: ["agent_c"],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 3,
    });

    // When only sendMode is updated. Then the other fields are preserved.
    await accept(
      api.userPreferences.update({
        headers: SESSION_AUTH,
        body: { sendMode: "enter" },
      }),
      [200],
    );
    const afterSendMode = await accept(
      api.userPreferences.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(afterSendMode.body).toStrictEqual({
      timezone: "America/New_York",
      pinnedAgentIds: ["agent_c"],
      sendMode: "enter",
      captureNetworkBodiesRemaining: 3,
    });

    // When only captureNetworkBodiesRemaining is updated. Then others persist.
    await accept(
      api.userPreferences.update({
        headers: SESSION_AUTH,
        body: { captureNetworkBodiesRemaining: 10 },
      }),
      [200],
    );
    const afterCapture = await accept(
      api.userPreferences.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(afterCapture.body).toStrictEqual({
      timezone: "America/New_York",
      pinnedAgentIds: ["agent_c"],
      sendMode: "enter",
      captureNetworkBodiesRemaining: 10,
    });
  });

  it("rejects invalid input and unauthenticated or no-org requests", async () => {
    const api = createBddApi(context);

    // Unauthenticated requests on both routes.
    await accept(api.userPreferences.get({ headers: {} }), [401]);
    await accept(
      api.userPreferences.update({
        headers: {},
        body: { timezone: "America/New_York" },
      }),
      [401],
    );

    // A session without an active organization.
    api.actAsNoOrg();
    await accept(api.userPreferences.get({ headers: SESSION_AUTH }), [401]);
    await accept(
      api.userPreferences.update({
        headers: SESSION_AUTH,
        body: { timezone: "America/New_York" },
      }),
      [401],
    );

    // An invalid timezone and an empty update.
    api.actAsAdmin();
    const badTimezone = await accept(
      api.userPreferences.update({
        headers: SESSION_AUTH,
        body: { timezone: "Invalid/Timezone" },
      }),
      [400],
    );
    expect(badTimezone.body.error.code).toBe("BAD_REQUEST");
    const noUpdate = await accept(
      api.userPreferences.update({ headers: SESSION_AUTH, body: {} }),
      [400],
    );
    expect(noUpdate.body.error.code).toBe("BAD_REQUEST");
  });
});
