import { randomUUID } from "node:crypto";

import { createApp } from "../../../app-factory";
import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the auth/validation/not-found rejections of reading,
// cancelling, and locating a run in the queue. Operating on an actual run needs a
// seeded run (created runs require credits with no API surface — GAP-RUN-CREDITS),
// so the success and cross-user/cross-org cases stay in the kept legacy. See
// `api.bdd.md` (CHAIN-RUN-READ-CANCEL-QUEUE).
const context = testContext();

describe("run read/cancel/queue rejections (API-first BDD)", () => {
  it("get-by-id rejects unauthenticated, org-less, malformed, and unknown runs", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(
      api.zeroRunsById.getById({ headers: {}, params: { id: randomUUID() } }),
      [401],
    );

    // No active organization.
    api.actAsNoOrg();
    await accept(
      api.zeroRunsById.getById({
        headers: SESSION_AUTH,
        params: { id: randomUUID() },
      }),
      [401],
    );

    // Malformed run id.
    api.actAsAdmin();
    const malformed = await accept(
      api.zeroRunsById.getById({
        headers: SESSION_AUTH,
        params: { id: "2b9b2303" },
      }),
      [400],
    );
    expect(malformed.body.error.code).toBe("BAD_REQUEST");

    // Unknown run.
    await accept(
      api.zeroRunsById.getById({
        headers: SESSION_AUTH,
        params: { id: randomUUID() },
      }),
      [404],
    );

    // A zero token without agent-run:read is forbidden.
    const zero = await accept(
      api.zeroRunsById.getById({
        headers: api.zeroAuth([]),
        params: { id: randomUUID() },
      }),
      [403],
    );
    expect(zero.body.error.message).toContain("agent-run:read");
  });

  it("cancel rejects unauthenticated, org-less, capability-less, and unknown runs", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(
      api.zeroRunsCancel.cancel({
        headers: {},
        params: { id: randomUUID() },
      }),
      [401],
    );

    // No active organization.
    api.actAsNoOrg();
    await accept(
      api.zeroRunsCancel.cancel({
        headers: SESSION_AUTH,
        params: { id: randomUUID() },
      }),
      [401],
    );

    // A zero token without agent-run:write is forbidden.
    const zero = await accept(
      api.zeroRunsCancel.cancel({
        headers: api.zeroAuth([]),
        params: { id: randomUUID() },
      }),
      [403],
    );
    expect(zero.body.error.message).toContain("agent-run:write");

    // Unknown run.
    api.actAsAdmin();
    await accept(
      api.zeroRunsCancel.cancel({
        headers: SESSION_AUTH,
        params: { id: randomUUID() },
      }),
      [404],
    );
  });

  it("queue-position rejects a missing runId and unauthenticated reads", async () => {
    const api = createBddApi(context);

    // A missing runId is a bad request before auth (raw request, since the
    // typed client always sends the query).
    const missing = await createApp({ signal: context.signal }).request(
      "/api/zero/queue-position",
      { method: "GET" },
    );
    expect(missing.status).toBe(400);
    expect(JSON.stringify(await missing.json())).toContain("runId");

    // Unauthenticated with a runId.
    await accept(
      api.zeroQueuePosition.getPosition({
        headers: {},
        query: { runId: randomUUID() },
      }),
      [401],
    );

    // An authenticated caller requesting an unknown run is not found.
    api.actAsAdmin();
    await accept(
      api.zeroQueuePosition.getPosition({
        headers: SESSION_AUTH,
        query: { runId: randomUUID() },
      }),
      [404],
    );
  });
});
