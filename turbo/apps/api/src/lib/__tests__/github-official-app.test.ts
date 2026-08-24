import { describe, expect, it } from "vitest";

import {
  githubAppBotUsername,
  githubAppUrl,
  resolveGithubAppIdentity,
} from "../github-official-app";

describe("official GitHub App identity", () => {
  it("derives provider names from the App slug", () => {
    expect(githubAppBotUsername("owner-managed-app")).toBe(
      "@owner-managed-app[bot]",
    );
    expect(githubAppUrl("owner-managed-app")).toBe(
      "https://github.com/apps/owner-managed-app",
    );
  });

  it("uses current provider config for the stable official App ID", () => {
    expect(
      resolveGithubAppIdentity({
        configuredAppId: "2994435",
        configuredAppSlug: "okou",
        installationAppId: "2994435",
        installationAppSlug: "vm0-ai-test",
      }),
    ).toStrictEqual({ appId: "2994435", appSlug: "okou" });
  });

  it("uses official config for legacy rows without App metadata", () => {
    expect(
      resolveGithubAppIdentity({
        configuredAppId: "2994435",
        configuredAppSlug: "okou",
        installationAppId: null,
        installationAppSlug: null,
      }),
    ).toStrictEqual({ appId: "2994435", appSlug: "okou" });
  });

  it("keeps user-managed App identity independent from official config", () => {
    expect(
      resolveGithubAppIdentity({
        configuredAppId: "2994435",
        configuredAppSlug: "okou",
        installationAppId: "8675309",
        installationAppSlug: "owner-managed-app",
      }),
    ).toStrictEqual({ appId: "8675309", appSlug: "owner-managed-app" });
  });
});
