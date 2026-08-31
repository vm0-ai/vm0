import { describe, expect, it } from "vitest";

import { getConnectorAuthProviderRegistrationCapabilities } from "../auth-providers/connector-auth";
import { isConnectorDirectOkouOauthCallbackReady } from "../app-oauth-callback";

const DIRECT_OKOU_READY_CONNECTORS = [
  "box",
  "cloudflare",
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
  "meta-ads",
  "microsoft-365",
  "notion",
  "outlook-calendar",
  "outlook-mail",
  "slack",
  "tiktok-ads",
  "youtube",
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

  it.each(["github", "test-oauth"])(
    "keeps %s on its existing callback",
    (connectorSlug) => {
      expect(isConnectorDirectOkouOauthCallbackReady(connectorSlug)).toBe(
        false,
      );
    },
  );
});
