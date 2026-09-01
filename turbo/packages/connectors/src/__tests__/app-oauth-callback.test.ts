import { describe, expect, it } from "vitest";

import { getConnectorAuthProviderRegistrationCapabilities } from "../auth-providers/connector-auth";
import { isConnectorDirectOkouOauthCallbackReady } from "../app-oauth-callback";

const DIRECT_OKOU_READY_CONNECTORS = [
  "ahrefs",
  "box",
  "cal-com",
  "canva",
  "close",
  "cloudflare",
  "copper",
  "datadog",
  "deel",
  "docusign",
  "dropbox",
  "figma",
  "garmin-connect",
  "github",
  "gmail",
  "google-ads",
  "google-analytics",
  "google-calendar",
  "google-cloud",
  "google-contacts",
  "google-docs",
  "google-drive",
  "google-forms",
  "google-maps",
  "google-meet",
  "google-search-console",
  "google-sheets",
  "hubspot",
  "mailchimp",
  "mercury",
  "meta-ads",
  "microsoft-365",
  "neon",
  "notion",
  "outlook-calendar",
  "outlook-mail",
  "posthog",
  "reddit",
  "slack",
  "spotify",
  "supabase",
  "tiktok-ads",
  "webflow",
  "youtube",
  "zoom",
] as const;

describe("direct Okou OAuth callback readiness", () => {
  it("contains exactly the ready executable auth-code connectors", () => {
    const directReadyConnectors = new Set(
      getConnectorAuthProviderRegistrationCapabilities()
        .filter((capability) => {
          return (
            capability.contract.grant.kind === "auth-code" &&
            isConnectorDirectOkouOauthCallbackReady(capability.connectorSlug)
          );
        })
        .map((capability) => {
          return capability.connectorSlug;
        }),
    );

    expect(directReadyConnectors).toStrictEqual(
      new Set(DIRECT_OKOU_READY_CONNECTORS),
    );
  });

  it.each(DIRECT_OKOU_READY_CONNECTORS)(
    "marks %s as direct-ready",
    (connectorSlug) => {
      expect(isConnectorDirectOkouOauthCallbackReady(connectorSlug)).toBe(true);
    },
  );

  it.each(["quickbooks", "test-oauth"])(
    "keeps %s on its existing callback",
    (connectorSlug) => {
      expect(isConnectorDirectOkouOauthCallbackReady(connectorSlug)).toBe(
        false,
      );
    },
  );
});
