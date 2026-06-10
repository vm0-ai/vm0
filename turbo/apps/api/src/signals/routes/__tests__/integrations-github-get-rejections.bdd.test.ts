import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the GitHub installation read rejections. An org
// with no GitHub App installation gets a 404 (with a null install URL when there
// is no seeded default-agent org context to derive one from). A connected
// installation, and the seeded-context install URL, need the GitHub OAuth flow
// (GAP-GITHUB-INSTALL) and stay in the kept legacy. See `api.bdd.md`
// (CHAIN-GITHUB-GET-REJECTIONS).
const context = testContext();

describe("github installation read rejections (API-first BDD)", () => {
  it("rejects unauthenticated and capability-less callers, and 404s with no installation", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    const unauth = await accept(
      api.githubIntegration.getInstallation({ headers: {} }),
      [401],
    );
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    // A zero token without github:read is forbidden.
    const zero = await accept(
      api.githubIntegration.getInstallation({ headers: api.zeroAuth([]) }),
      [403],
    );
    expect(zero.body.error.message).toBe(
      "Missing required capability: github:read",
    );

    // An authenticated caller with no installation gets a 404; with no seeded
    // org context there is no install URL to offer.
    api.actAsAdmin();
    const noInstall = await accept(
      api.githubIntegration.getInstallation({ headers: SESSION_AUTH }),
      [404],
    );
    expect(noInstall.body.error.message).toBe("No GitHub installation found");
    expect(noInstall.body.installUrl).toBeNull();
  });
});
