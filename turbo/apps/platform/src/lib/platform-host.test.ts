import { describe, expect, it } from "vitest";

import {
  derivePlatformServiceOrigin,
  resolvePlatformEnvironment,
  resolvePlatformRuntimeConfig,
  rewritePlatformHostname,
} from "./platform-host.ts";

function setBrowserUrl(url: string): void {
  window.location.href = url;
}

describe("platform runtime host configuration", () => {
  it("uses canonical services for every production app hostname", () => {
    setBrowserUrl("https://cf-app.vm0.ai/agents");

    expect(resolvePlatformEnvironment()).toBe("production");
    expect(derivePlatformServiceOrigin(window.location.origin, "api")).toBe(
      "https://api.vm0.ai",
    );
    expect(derivePlatformServiceOrigin(window.location.origin, "www")).toBe(
      "https://www.vm0.ai",
    );

    const config = resolvePlatformRuntimeConfig();
    expect(config.clerkPublishableKey).toBe("production_clerk_key");
    expect(config.publicArtifactsBaseUrl).toBe("https://cdn.vm0.io");
    expect(config.zeroHostDomain).toBe("sites.vm0.io");
  });

  it("preserves the deployment prefix for preview service hosts", () => {
    setBrowserUrl("https://pr-21565-app.vm6.ai/agents");

    expect(resolvePlatformEnvironment()).toBe("preview");
    expect(derivePlatformServiceOrigin(window.location.origin, "api")).toBe(
      "https://pr-21565-api.vm6.ai",
    );
    expect(derivePlatformServiceOrigin(window.location.origin, "www")).toBe(
      "https://pr-21565-www.vm6.ai",
    );

    const config = resolvePlatformRuntimeConfig();
    expect(config.clerkPublishableKey).toBe("preview_clerk_key");
    expect(config.publicArtifactsBaseUrl).toBe("https://cdn.vm7.io");
    expect(config.zeroHostDomain).toBe("sites.vm7.io");
    expect(config.postHogKey).toBeNull();
    expect(config.sentryDsn).toBeNull();
  });

  it("keeps protocol and port for development service hosts", () => {
    expect(derivePlatformServiceOrigin("https://app.vm7.ai:8443", "api")).toBe(
      "https://api.vm7.ai:8443",
    );
  });

  it("only rewrites a recognized service label", () => {
    expect(rewritePlatformHostname("pr-21565-app.vm6.ai", "api")).toBe(
      "pr-21565-api.vm6.ai",
    );
    expect(rewritePlatformHostname("example.pages.dev", "api")).toBe(
      "example.pages.dev",
    );
  });
});
