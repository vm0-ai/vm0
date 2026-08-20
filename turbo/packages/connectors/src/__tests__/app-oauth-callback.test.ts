import { describe, expect, it } from "vitest";

import { isConnectorDirectOkouOauthCallbackReady } from "../app-oauth-callback";

const DIRECT_OKOU_READY_CONNECTORS = [
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
  "microsoft-365",
  "outlook-calendar",
  "outlook-mail",
  "youtube",
] as const;

describe("direct Okou OAuth callback readiness", () => {
  it.each(DIRECT_OKOU_READY_CONNECTORS)(
    "marks %s as direct-ready",
    (connectorSlug) => {
      expect(isConnectorDirectOkouOauthCallbackReady(connectorSlug)).toBe(true);
    },
  );

  it.each(["github", "slack", "test-oauth"])(
    "keeps %s on its existing callback",
    (connectorSlug) => {
      expect(isConnectorDirectOkouOauthCallbackReady(connectorSlug)).toBe(
        false,
      );
    },
  );
});
