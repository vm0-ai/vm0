import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";

// API-first BDD coverage for the runner realtime-token auth rejections. A
// successful token (and the invalid/expired CLI-token, non-vm0-group and
// user-token variants) needs a valid runner/CLI token plus group config the
// helper does not build, so they stay in the kept legacy. See `api.bdd.md`
// (CHAIN-RUNNER-REALTIME-TOKEN-REJECTIONS).
const context = testContext();

describe("runner realtime token rejections (API-first BDD)", () => {
  it("rejects requests with no authorization and with non-Bearer authorization", async () => {
    const api = createBddApi(context);
    const body = { group: "vm0/test" } as const;

    // No Authorization header.
    await accept(api.runnerRealtimeToken.create({ body, headers: {} }), [401]);

    // A non-Bearer Authorization header.
    await accept(
      api.runnerRealtimeToken.create({
        body,
        headers: { authorization: "Basic sometoken" },
      }),
      [401],
    );
  });
});
