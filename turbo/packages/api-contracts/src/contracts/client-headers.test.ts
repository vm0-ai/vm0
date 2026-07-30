import { describe, expect, it } from "vitest";
import {
  addClientCapabilityToVersion,
  clientVersionSupportsCapability,
  CLIENT_CAPABILITY_CONNECTOR_SLUG_IDENTITIES,
  CLIENT_CAPABILITY_ES_ES_LOCALE,
  CLIENT_CAPABILITY_JA_JP_LOCALE,
  CLIENT_CAPABILITY_KO_KR_LOCALE,
  CLIENT_CAPABILITY_ID_ID_LOCALE,
  CLIENT_CAPABILITY_DE_DE_LOCALE,
  CLIENT_CAPABILITY_PT_BR_LOCALE,
  CLIENT_FORCE_UPGRADE_STATUS,
  CLIENT_HEADER_NAMES,
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
  ZERO_MAIL_CLIENT_VERSION,
  ZERO_MAIL_CLIENT_VERSION_HEADER,
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
      CLIENT_SESSION_ID_HEADER,
      CLIENT_REQUEST_ID_HEADER,
      ZERO_MAIL_CLIENT_VERSION_HEADER,
    ]);
    expect(CLIENT_HEADER_NAMES).toStrictEqual([
      "X-Client-Version",
      "X-Client-Type",
      "X-Client-Session-Id",
      "X-Client-Request-Id",
      "X-Zero-Mail-Client-Version",
    ]);
  });

  it("identifies clients that understand link-backed Gmail draft cards", () => {
    expect(ZERO_MAIL_CLIENT_VERSION).toBe("3");
  });

  it("advertises capabilities through backward-compatible version metadata", () => {
    const version = addClientCapabilityToVersion(
      addClientCapabilityToVersion(
        addClientCapabilityToVersion(
          addClientCapabilityToVersion(
            addClientCapabilityToVersion(
              addClientCapabilityToVersion(
                addClientCapabilityToVersion(
                  "0.636.1",
                  CLIENT_CAPABILITY_PT_BR_LOCALE,
                ),
                CLIENT_CAPABILITY_JA_JP_LOCALE,
              ),
              CLIENT_CAPABILITY_KO_KR_LOCALE,
            ),
            CLIENT_CAPABILITY_ID_ID_LOCALE,
          ),
          CLIENT_CAPABILITY_DE_DE_LOCALE,
        ),
        CLIENT_CAPABILITY_ES_ES_LOCALE,
      ),
      CLIENT_CAPABILITY_CONNECTOR_SLUG_IDENTITIES,
    );
    expect(version).toBe(
      "0.636.1+pt-br-locale-v1.ja-jp-locale-v1.ko-kr-locale-v1.id-id-locale-v1.de-de-locale-v1.es-es-locale-v1.connector-slug-identities-v1",
    );
    expect(
      clientVersionSupportsCapability(version, CLIENT_CAPABILITY_PT_BR_LOCALE),
    ).toBe(true);
    expect(
      clientVersionSupportsCapability(version, CLIENT_CAPABILITY_JA_JP_LOCALE),
    ).toBe(true);
    expect(
      clientVersionSupportsCapability(version, CLIENT_CAPABILITY_KO_KR_LOCALE),
    ).toBe(true);
    expect(
      clientVersionSupportsCapability(version, CLIENT_CAPABILITY_ID_ID_LOCALE),
    ).toBe(true);
    expect(
      clientVersionSupportsCapability(version, CLIENT_CAPABILITY_DE_DE_LOCALE),
    ).toBe(true);
    expect(
      clientVersionSupportsCapability(version, CLIENT_CAPABILITY_ES_ES_LOCALE),
    ).toBe(true);
    expect(
      clientVersionSupportsCapability(
        version,
        CLIENT_CAPABILITY_CONNECTOR_SLUG_IDENTITIES,
      ),
    ).toBe(true);
    expect(
      clientVersionSupportsCapability(
        "0.631.1",
        CLIENT_CAPABILITY_DE_DE_LOCALE,
      ),
    ).toBe(false);
  });

  it("keeps the force upgrade status stable for app clients", () => {
    expect(CLIENT_FORCE_UPGRADE_STATUS).toBe(426);
  });
});
