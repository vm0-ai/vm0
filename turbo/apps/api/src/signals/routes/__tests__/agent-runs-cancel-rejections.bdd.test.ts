import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the run-cancel auth and not-found cases. Cancelling
// a real run (running / queued / already-cancelled / not-cancellable, queue
// drain, callbacks) needs a funded in-flight run (GAP-RUN-CREDITS), and the
// other-org 404 / sandbox-source 404 variants need seeded runs; those stay in
// the kept legacy. See `api.bdd.md` (CHAIN-AGENT-RUNS-CANCEL-REJECTIONS).
const context = testContext();

const UNKNOWN_RUN = "00000000-0000-4000-8000-00000000000a";

describe("agent run cancel rejections (API-first BDD)", () => {
  it("rejects unauthenticated callers and 404s an unknown run", async () => {
    const api = createBddApi(context);

    await accept(
      api.runsCancel.cancel({
        params: { id: UNKNOWN_RUN },
        headers: {},
      }),
      [401],
    );

    api.actAsAdmin();
    const notFound = await accept(
      api.runsCancel.cancel({
        params: { id: UNKNOWN_RUN },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(notFound.body.error.code).toBe("NOT_FOUND");
  });
});
