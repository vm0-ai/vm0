import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the storage list + download auth, empty and
// not-found cases. Listing/downloading a real artifact or volume needs storage
// created by a run or connect flow (GAP-RUN-CREDITS / GAP-CONNECTOR-CONNECT), the
// sandbox-token run-scoping variants need a seeded run, and the invalid-type /
// missing-param 400s require deliberately ill-typed queries the ts-rest client
// can only send via `as never`; those stay in the kept legacy. See `api.bdd.md`
// (CHAIN-STORAGES-REJECTIONS).
const context = testContext();

describe("storage list + download rejections (API-first BDD)", () => {
  it("list rejects unauthenticated callers and returns an empty array for a fresh org", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    const unauth = await accept(
      api.storagesList.list({ query: { type: "artifact" }, headers: {} }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // A fresh org has no storages.
    api.actAsAdmin();
    const empty = await accept(
      api.storagesList.list({
        query: { type: "artifact" },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(empty.body).toStrictEqual([]);
  });

  it("download rejects unauthenticated callers and 404s a missing storage", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(
      api.storagesDownload.download({
        query: { name: "missing", type: "artifact" },
        headers: {},
      }),
      [401],
    );

    // A valid session downloading a storage that does not exist.
    api.actAsAdmin();
    const notFound = await accept(
      api.storagesDownload.download({
        query: { name: "missing", type: "artifact" },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(notFound.body.error.code).toBe("NOT_FOUND");
    expect(notFound.body.error.message).toContain("not found");
  });
});
