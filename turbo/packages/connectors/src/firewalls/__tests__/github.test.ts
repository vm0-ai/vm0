import { describe, expect, it } from "vitest";

import { extractSecretNamesFromApis } from "../../firewall-types";
import { githubFirewall } from "../github.generated";

/**
 * Structural sanity tests for the generated GitHub firewall config.
 *
 * The generator itself validates against firewallConfigSchema at build
 * time, so these tests focus on GitHub-specific invariants that the
 * schema cannot express: the set of hosts we intend to cover, and the
 * single-secret contract (all auth headers reference GITHUB_TOKEN only).
 */
describe("githubFirewall", () => {
  it("covers every host the GitHub connector is expected to authenticate", () => {
    const bases = githubFirewall.apis.map((a) => {
      return a.base;
    });
    expect(bases).toEqual([
      "https://api.github.com",
      "https://uploads.github.com",
      "https://github.com/{owner}/{repo}.git",
      "https://gist.github.com/{gist_id}.git",
      "https://gist.github.com/{user}/{gist_id}.git",
      "https://raw.githubusercontent.com/{owner}/{repo}",
      "https://codeload.github.com/{owner}/{repo}",
      "https://npm.pkg.github.com",
    ]);
  });

  it("references only GITHUB_TOKEN across all apis", () => {
    expect(extractSecretNamesFromApis([...githubFirewall.apis])).toEqual([
      "GITHUB_TOKEN",
    ]);
  });

  it("uses Basic auth with x-access-token for git-protocol surfaces", () => {
    const basicBases = [
      "https://github.com/{owner}/{repo}.git",
      "https://gist.github.com/{gist_id}.git",
      "https://gist.github.com/{user}/{gist_id}.git",
      "https://raw.githubusercontent.com/{owner}/{repo}",
      "https://codeload.github.com/{owner}/{repo}",
    ];
    for (const base of basicBases) {
      const entry = githubFirewall.apis.find((a) => {
        return a.base === base;
      });
      expect(entry?.auth.headers?.Authorization).toBe(
        '${{ basic("x-access-token", secrets.GITHUB_TOKEN) }}',
      );
    }
  });

  it("uses Bearer for REST, uploads, and npm registry", () => {
    const bearerBases = [
      "https://api.github.com",
      "https://uploads.github.com",
      "https://npm.pkg.github.com",
    ];
    for (const base of bearerBases) {
      const entry = githubFirewall.apis.find((a) => {
        return a.base === base;
      });
      expect(entry?.auth.headers?.Authorization).toBe(
        "Bearer ${{ secrets.GITHUB_TOKEN }}",
      );
    }
  });
});
