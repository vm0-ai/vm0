import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the chat-thread artifact list auth and not-found
// cases. Listing real artifacts (grouped by run, dedup, hosted-site /
// presentation filtering, googleDriveSync status) needs seeded runs with
// uploaded files (GAP-RUN-CREDITS), and the other-user 404 needs a seeded
// foreign thread; those stay in the kept legacy. See `api.bdd.md`
// (CHAIN-ARTIFACTS-LIST-REJECTIONS).
const context = testContext();

const THREAD = "00000000-0000-4000-8000-00000000000d";

describe("chat-thread artifact list rejections (API-first BDD)", () => {
  it("rejects unauthenticated callers and 404s an unknown thread", async () => {
    const api = createBddApi(context);

    await accept(
      api.chatThreadArtifacts.list({
        params: { threadId: THREAD },
        headers: {},
      }),
      [401],
    );

    api.actAsAdmin();
    await accept(
      api.chatThreadArtifacts.list({
        params: { threadId: THREAD },
        headers: SESSION_AUTH,
      }),
      [404],
    );
  });
});
