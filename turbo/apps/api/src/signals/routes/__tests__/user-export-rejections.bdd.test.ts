import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the user data-export get + post auth and
// no-previous-export cases. The completed / pending / failed / cooldown export
// states and the create-and-complete flow need a seeded export job and the
// export executor, so they stay in the kept legacy. See `api.bdd.md`
// (CHAIN-USER-EXPORT-REJECTIONS).
const context = testContext();

describe("user export rejections (API-first BDD)", () => {
  it("get rejects unauthenticated callers and allows export for a user with no prior exports", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(api.userExport.get({ headers: {} }), [401]);

    // A user with no previous export has no job and may export.
    api.actAsAdmin();
    const status = await accept(
      api.userExport.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(status.body).toStrictEqual({
      job: null,
      canExport: true,
      nextExportAt: null,
    });
  });

  it("post rejects unauthenticated and org-less callers", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(api.userExport.post({ headers: {} }), [401]);

    // No active organization.
    api.actAsNoOrg();
    await accept(api.userExport.post({ headers: SESSION_AUTH }), [401]);
  });
});
