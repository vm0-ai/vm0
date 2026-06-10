import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the GitHub installation delete + patch auth,
// validation and not-found cases. Deleting / patching an actual installation,
// and the admin-mismatch 403 variants, need a seeded installation row
// (GAP-GITHUB-INSTALL) and stay in the kept legacy, as do the missing-field /
// malformed-JSON 400s that need a raw request the ts-rest client can't send.
// See `api.bdd.md` (CHAIN-GITHUB-MUTATIONS-REJECTIONS).
const context = testContext();

describe("github installation delete/patch rejections (API-first BDD)", () => {
  it("delete rejects unauthenticated callers and 404s a missing installation", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    const unauth = await accept(
      api.githubIntegration.deleteInstallation({ headers: {} }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Authenticated admin with no installation.
    api.actAsAdmin();
    const notFound = await accept(
      api.githubIntegration.deleteInstallation({ headers: SESSION_AUTH }),
      [404],
    );
    expect(notFound.body).toStrictEqual({
      error: { message: "No GitHub installation found", code: "NOT_FOUND" },
    });
  });

  it("patch rejects unauthenticated callers, validates agentName, and 404s a missing installation", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(
      api.githubIntegration.updateInstallation({
        headers: {},
        body: { agentName: "test-agent" },
      }),
      [401],
    );

    // An empty agentName fails body validation.
    api.actAsAdmin();
    await accept(
      api.githubIntegration.updateInstallation({
        headers: SESSION_AUTH,
        body: { agentName: "" },
      }),
      [400],
    );

    // A valid body with no installation 404s.
    const notFound = await accept(
      api.githubIntegration.updateInstallation({
        headers: SESSION_AUTH,
        body: { agentName: "test-agent" },
      }),
      [404],
    );
    expect(notFound.body).toStrictEqual({
      error: { message: "No GitHub installation found", code: "NOT_FOUND" },
    });
  });
});
