import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../../__tests__/test-server";
import {
  buildSteamOpenIdAuthorizationUrl,
  verifySteamOpenIdCallback,
} from "../steam/openid";

const STEAM_ID = "76561198000000000";
const RETURN_TO = "https://api.vm0.ai/api/connectors/steam/callback?state=abc";
const REALM = "https://vm0.ai/";

function callbackParams(
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const claimedId = `https://steamcommunity.com/openid/id/${STEAM_ID}`;
  return {
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": "https://steamcommunity.com/openid/login",
    "openid.claimed_id": claimedId,
    "openid.identity": claimedId,
    "openid.return_to": RETURN_TO,
    "openid.response_nonce": "2026-07-06T00:00:00Znonce",
    "openid.assoc_handle": "assoc-handle",
    "openid.signed":
      "op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "signature",
    ...overrides,
  };
}

function mockSteamVerification(args: {
  readonly valid: boolean;
  readonly onRequest?: (body: URLSearchParams) => void;
}): void {
  server.use(
    http.post(
      "https://steamcommunity.com/openid/login",
      async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        args.onRequest?.(body);
        return new HttpResponse(
          [
            "ns:http://specs.openid.net/auth/2.0",
            `is_valid:${args.valid ? "true" : "false"}`,
            "",
          ].join("\n"),
          { headers: { "content-type": "text/plain" } },
        );
      },
    ),
  );
}

describe("Steam OpenID provider", () => {
  it("builds the Steam OpenID authorization URL", () => {
    const authorizationUrl = new URL(
      buildSteamOpenIdAuthorizationUrl({
        returnTo: RETURN_TO,
        realm: REALM,
      }),
    );

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://steamcommunity.com/openid/login",
    );
    expect(authorizationUrl.searchParams.get("openid.ns")).toBe(
      "http://specs.openid.net/auth/2.0",
    );
    expect(authorizationUrl.searchParams.get("openid.mode")).toBe(
      "checkid_setup",
    );
    expect(authorizationUrl.searchParams.get("openid.return_to")).toBe(
      RETURN_TO,
    );
    expect(authorizationUrl.searchParams.get("openid.realm")).toBe(REALM);
    expect(authorizationUrl.searchParams.get("openid.claimed_id")).toBe(
      "http://specs.openid.net/auth/2.0/identifier_select",
    );
    expect(authorizationUrl.searchParams.get("openid.identity")).toBe(
      "http://specs.openid.net/auth/2.0/identifier_select",
    );
  });

  it("verifies a Steam assertion through check_authentication", async () => {
    mockSteamVerification({
      valid: true,
      onRequest: (body) => {
        expect(body.get("openid.mode")).toBe("check_authentication");
        expect(body.get("openid.claimed_id")).toBe(
          `https://steamcommunity.com/openid/id/${STEAM_ID}`,
        );
      },
    });

    await expect(
      verifySteamOpenIdCallback(
        {
          callbackParams: callbackParams(),
          expectedReturnTo: RETURN_TO,
          expectedRealm: REALM,
        },
        new AbortController().signal,
      ),
    ).resolves.toStrictEqual({ steamId: STEAM_ID });
  });

  it("rejects assertions for a different return_to", async () => {
    mockSteamVerification({ valid: true });

    await expect(
      verifySteamOpenIdCallback(
        {
          callbackParams: callbackParams({
            "openid.return_to":
              "https://api.vm0.ai/api/connectors/steam/callback?state=other",
          }),
          expectedReturnTo: RETURN_TO,
          expectedRealm: REALM,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("unexpected return URL");
  });

  it("rejects invalid Steam verification responses", async () => {
    mockSteamVerification({ valid: false });

    await expect(
      verifySteamOpenIdCallback(
        {
          callbackParams: callbackParams(),
          expectedReturnTo: RETURN_TO,
          expectedRealm: REALM,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("assertion was not valid");
  });

  it("rejects malformed claimed IDs", async () => {
    mockSteamVerification({ valid: true });

    await expect(
      verifySteamOpenIdCallback(
        {
          callbackParams: callbackParams({
            "openid.claimed_id":
              "https://steamcommunity.com/profiles/not-steam",
          }),
          expectedReturnTo: RETURN_TO,
          expectedRealm: REALM,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("invalid claimed ID");
  });

  it("accepts the official HTTP claimed ID format", async () => {
    mockSteamVerification({ valid: true });

    await expect(
      verifySteamOpenIdCallback(
        {
          callbackParams: callbackParams({
            "openid.claimed_id": `http://steamcommunity.com/openid/id/${STEAM_ID}`,
            "openid.identity": `http://steamcommunity.com/openid/id/${STEAM_ID}`,
          }),
          expectedReturnTo: RETURN_TO,
          expectedRealm: REALM,
        },
        new AbortController().signal,
      ),
    ).resolves.toStrictEqual({ steamId: STEAM_ID });
  });

  it("rejects assertions that do not sign required identity fields", async () => {
    await expect(
      verifySteamOpenIdCallback(
        {
          callbackParams: callbackParams({
            "openid.signed":
              "op_endpoint,return_to,response_nonce,assoc_handle",
          }),
          expectedReturnTo: RETURN_TO,
          expectedRealm: REALM,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("did not sign required fields");
  });
});
