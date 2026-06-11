import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the chat-thread Google-Drive artifact-sync auth and
// no-connector cases. Syncing a real artifact (the full MSW Drive upload flows,
// the unknown-artifact 404 and invalid-body 400) needs a connected Google Drive
// connector plus seeded run artifacts (GAP-CONNECTOR-CONNECT / GAP-RUN-CREDITS)
// and stays in the kept legacy. See `api.bdd.md`
// (CHAIN-ARTIFACTS-SYNC-REJECTIONS).
const context = testContext();

const THREAD = "00000000-0000-4000-8000-00000000000c";

describe("chat-thread artifact sync rejections (API-first BDD)", () => {
  it("rejects unauthenticated / org-less callers and 400s when no Google Drive is connected", async () => {
    const api = createBddApi(context);
    const body = { runId: "run-1", fileId: "file-1" };

    // Unauthenticated.
    await accept(
      api.chatThreadArtifacts.syncGoogleDrive({
        params: { threadId: THREAD },
        body,
        headers: {},
      }),
      [401],
    );

    // No active organization.
    api.actAsNoOrg();
    await accept(
      api.chatThreadArtifacts.syncGoogleDrive({
        params: { threadId: THREAD },
        body,
        headers: SESSION_AUTH,
      }),
      [401],
    );

    // An admin with no Google Drive connector cannot sync.
    api.actAsAdmin();
    const noConnector = await accept(
      api.chatThreadArtifacts.syncGoogleDrive({
        params: { threadId: THREAD },
        body,
        headers: SESSION_AUTH,
      }),
      [400],
    );
    expect(noConnector.body.error.message).toBe(
      "Connect Google Drive before syncing artifacts",
    );
  });
});
