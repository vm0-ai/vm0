import { describe, expect, it } from "vitest";
import {
  CLIENT_FORCE_UPGRADE_STATUS,
  CLIENT_FEEDBACK_LOCATION_VERSION_TAG,
  CLIENT_HEADER_NAMES,
  CLIENT_PRODUCT_HEADER,
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_APP,
  CLIENT_TYPE_CLI,
  CLIENT_TYPE_DESKTOP,
  CLIENT_TYPE_GUEST_AGENT,
  CLIENT_TYPE_HEADER,
  CLIENT_TYPE_MITM_ADDON,
  CLIENT_TYPE_RUNNER,
  CLIENT_VERSION_HEADER,
  DESKTOP_PRODUCT_OKOU,
  DESKTOP_PRODUCT_ZERO,
  clientVersionHasTag,
  clientVersionWithTag,
  desktopProductFromClientHeader,
} from "./client-headers";

describe("client header contract", () => {
  it("documents the canonical X-Client-Type wire values", () => {
    expect({
      app: CLIENT_TYPE_APP,
      cli: CLIENT_TYPE_CLI,
      desktop: CLIENT_TYPE_DESKTOP,
      guestAgent: CLIENT_TYPE_GUEST_AGENT,
      mitmAddon: CLIENT_TYPE_MITM_ADDON,
      runner: CLIENT_TYPE_RUNNER,
    }).toStrictEqual({
      app: "App",
      cli: "CLI",
      desktop: "Desktop",
      guestAgent: "GuestAgent",
      mitmAddon: "MitmAddon",
      runner: "Runner",
    });
  });

  it("keeps client header names stable for CORS and request logs", () => {
    expect(CLIENT_HEADER_NAMES).toStrictEqual([
      CLIENT_VERSION_HEADER,
      CLIENT_TYPE_HEADER,
      CLIENT_PRODUCT_HEADER,
      CLIENT_SESSION_ID_HEADER,
      CLIENT_REQUEST_ID_HEADER,
    ]);
    expect(CLIENT_HEADER_NAMES).toStrictEqual([
      "X-Client-Version",
      "X-Client-Type",
      "X-Client-Product",
      "X-Client-Session-Id",
      "X-Client-Request-Id",
    ]);
  });

  it("defaults missing desktop product identity to Zero", () => {
    expect(desktopProductFromClientHeader(undefined)).toBe(
      DESKTOP_PRODUCT_ZERO,
    );
    expect(desktopProductFromClientHeader(DESKTOP_PRODUCT_ZERO)).toBe(
      DESKTOP_PRODUCT_ZERO,
    );
    expect(desktopProductFromClientHeader(DESKTOP_PRODUCT_OKOU)).toBe(
      DESKTOP_PRODUCT_OKOU,
    );
  });

  it("keeps the force upgrade status stable for app clients", () => {
    expect(CLIENT_FORCE_UPGRADE_STATUS).toBe(426);
  });

  it("advertises additive App reader capabilities in version build metadata", () => {
    const taggedVersion = clientVersionWithTag(
      "0.734.0",
      CLIENT_FEEDBACK_LOCATION_VERSION_TAG,
    );
    const taggedExistingBuild = clientVersionWithTag(
      "0.734.0+preview",
      CLIENT_FEEDBACK_LOCATION_VERSION_TAG,
    );

    expect(taggedVersion).toBe("0.734.0+feedback-location-v1");
    expect(taggedExistingBuild).toBe("0.734.0+preview.feedback-location-v1");
    expect(
      clientVersionHasTag(taggedVersion, CLIENT_FEEDBACK_LOCATION_VERSION_TAG),
    ).toBe(true);
    expect(
      clientVersionHasTag("0.734.0", CLIENT_FEEDBACK_LOCATION_VERSION_TAG),
    ).toBe(false);
  });
});
