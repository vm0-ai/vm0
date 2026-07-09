import { randomUUID } from "node:crypto";

import { zeroMemoryActivityContract } from "@vm0/api-contracts/contracts/zero-memory-activity";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function activityClient() {
  return setupApp({ context })(zeroMemoryActivityContract);
}

/*
 * Auth and empty-timeline coverage for the memory activity read surface.
 * Populated-timeline behavior (entry ordering, item ordering, pagination,
 * quiet-day omission, and per-user/org scoping) is covered in
 * cron-summarize-memory.test.ts, where the summaries are produced through the
 * real summarize cron over product-committed storage versions.
 */
describe("GET /api/zero/memory/activity", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(activityClient().get({ headers: {} }), [401]);
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const response = await accept(
      activityClient().get({ headers: authHeaders() }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns an empty timeline when the user has no summaries", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      activityClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ entries: [], nextCursor: null });
  });
});
