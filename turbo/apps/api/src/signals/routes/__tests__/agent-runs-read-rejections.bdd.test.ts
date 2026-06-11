import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the CLI-facing run list, get-by-id and queue auth,
// validation, not-found and empty-queue cases. Listing/reading real runs and a
// non-empty queue (FIFO ordering, privacy filtering, running-task estimates)
// need funded runs (GAP-RUN-CREDITS), and the other-user / other-org 404 variants
// need seeded foreign runs; those stay in the kept legacy. See `api.bdd.md`
// (CHAIN-AGENT-RUNS-READ-REJECTIONS).
const context = testContext();

const UNKNOWN_RUN = "00000000-0000-4000-8000-000000000007";

describe("agent runs read rejections (API-first BDD)", () => {
  it("list rejects unauthenticated callers and invalid status/date filters", async () => {
    const api = createBddApi(context);

    await accept(api.runsList.list({ query: {}, headers: {} }), [401]);

    api.actAsAdmin();
    await accept(
      api.runsList.list({
        query: { status: "running,invalid" },
        headers: SESSION_AUTH,
      }),
      [400],
    );
    await accept(
      api.runsList.list({
        query: { since: "not-a-date" },
        headers: SESSION_AUTH,
      }),
      [400],
    );
    await accept(
      api.runsList.list({
        query: { until: "not-a-date" },
        headers: SESSION_AUTH,
      }),
      [400],
    );
  });

  it("get-by-id rejects an invalid uuid and 404s an unknown run", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    await accept(
      api.runsById.getById({
        params: { id: "2b9b2303" },
        headers: SESSION_AUTH,
      }),
      [400],
    );

    await accept(
      api.runsById.getById({
        params: { id: UNKNOWN_RUN },
        headers: SESSION_AUTH,
      }),
      [404],
    );
  });

  it("queue rejects unauthenticated callers and is empty for a fresh org", async () => {
    const api = createBddApi(context);

    await accept(api.runsQueue.getQueue({ headers: {} }), [401]);

    api.actAsAdmin();
    const queue = await accept(
      api.runsQueue.getQueue({ headers: SESSION_AUTH }),
      [200],
    );
    expect(queue.body.queue).toStrictEqual([]);
    expect(queue.body.runningTasks).toStrictEqual([]);
    expect(queue.body.concurrency.active).toBe(0);
  });
});
