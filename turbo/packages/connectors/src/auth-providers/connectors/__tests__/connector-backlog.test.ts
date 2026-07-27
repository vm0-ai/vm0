import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import {
  buildCalComAuthorizationUrl,
  exchangeCalComCode,
  refreshCalComToken,
} from "../cal-com/oauth";
import {
  buildCopperAuthorizationUrl,
  exchangeCopperCode,
} from "../copper/oauth";
import {
  buildDatadogAuthorizationUrl,
  exchangeDatadogCode,
  refreshDatadogToken,
} from "../datadog/oauth";
import { refreshNetSuiteAccessToken } from "../netsuite/api-token";
import { fetchPayPalAccessToken } from "../paypal/api-token";
import { fetchRampAccessToken } from "../ramp/api-token";
import { refreshWorkdayAccessToken } from "../workday/api-token";
import { server } from "../../__tests__/test-server";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

const signal = new AbortController().signal;
const CAL_COM_GRANT = authCodeGrantFixture([
  "BOOKING_READ",
  "BOOKING_WRITE",
  "EVENT_TYPE_READ",
  "EVENT_TYPE_WRITE",
  "PROFILE_READ",
  "SCHEDULE_READ",
]);
const COPPER_GRANT = authCodeGrantFixture(["developer/v1/all"]);
const DATADOG_GRANT = authCodeGrantFixture([
  "dashboards_read",
  "events_read",
  "incident_read",
  "logs_read_index_data",
  "metrics_read",
  "monitors_read",
  "slos_read",
]);

describe("connector backlog auth providers", () => {
  it("exchanges and refreshes Cal.com OAuth tokens", async () => {
    let meVersion: string | null = null;
    server.use(
      http.post(
        "https://api.cal.com/v2/auth/oauth2/token",
        async ({ request }) => {
          const body = new URLSearchParams(await request.text());
          return HttpResponse.json(
            body.get("grant_type") === "refresh_token"
              ? {
                  access_token: "cal-refreshed-token",
                  refresh_token: "cal-rotated-refresh-token",
                  expires_in: 3600,
                }
              : {
                  access_token: "cal-access-token",
                  refresh_token: "cal-refresh-token",
                  expires_in: 3600,
                  scope: "BOOKING_READ PROFILE_READ",
                },
          );
        },
      ),
      http.get("https://api.cal.com/v2/me", ({ request }) => {
        meVersion = request.headers.get("cal-api-version");
        return HttpResponse.json({
          data: {
            id: 123,
            username: "test-user",
            email: "test@example.com",
          },
        });
      }),
    );

    const grant = CAL_COM_GRANT;
    const url = buildCalComAuthorizationUrl(
      grant,
      "client-id",
      "https://example.com/callback",
      "state",
    );
    expect(url).toContain("app.cal.com/auth/oauth2/authorize");
    expect(url).toContain("scope=BOOKING_READ");

    await expect(
      exchangeCalComCode({
        grant,
        clientId: "client-id",
        clientSecret: "client-secret",
        code: "code",
        redirectUri: "https://example.com/callback",
      }),
    ).resolves.toMatchObject({
      accessToken: "cal-access-token",
      refreshToken: "cal-refresh-token",
      scopes: ["BOOKING_READ", "PROFILE_READ"],
      userInfo: { id: "123", username: "test-user" },
    });
    expect(meVersion).toBe("2024-08-13");

    await expect(
      refreshCalComToken({
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "cal-refresh-token",
        signal,
      }),
    ).resolves.toMatchObject({
      accessToken: "cal-refreshed-token",
      refreshToken: "cal-rotated-refresh-token",
    });
  });

  it("exchanges a Copper authorization code", async () => {
    server.use(
      http.post("https://app.copper.com/oauth/token", () => {
        return HttpResponse.json({
          access_token: "copper-access-token",
          scope: "developer/v1/all",
        });
      }),
      http.get("https://api.copper.com/developer_api/v1/account", () => {
        return HttpResponse.json({ id: 42, name: "Copper Account" });
      }),
    );

    const grant = COPPER_GRANT;
    const url = buildCopperAuthorizationUrl(
      grant,
      "client-id",
      "https://example.com/callback",
      "state",
    );
    expect(url).toContain("app.copper.com/oauth/authorize");
    expect(url).toContain("scope=developer%2Fv1%2Fall");

    await expect(
      exchangeCopperCode({
        grant,
        clientId: "client-id",
        clientSecret: "client-secret",
        code: "code",
        redirectUri: "https://example.com/callback",
      }),
    ).resolves.toMatchObject({
      accessToken: "copper-access-token",
      userInfo: { id: "42", username: "Copper Account" },
    });
  });

  it("uses Datadog PKCE and the callback-selected site", async () => {
    server.use(
      http.post(
        "https://api.us2.ddog-gov.com/oauth2/v1/token",
        async ({ request }) => {
          const body = new URLSearchParams(await request.text());
          return HttpResponse.json(
            body.get("grant_type") === "refresh_token"
              ? {
                  access_token: "datadog-refreshed-token",
                  refresh_token: "datadog-rotated-refresh-token",
                  expires_in: 3600,
                }
              : {
                  access_token: "datadog-access-token",
                  refresh_token: "datadog-refresh-token",
                  expires_in: 3600,
                  scope: "dashboards_read logs_read_index_data",
                },
          );
        },
      ),
    );

    const grant = DATADOG_GRANT;
    const authorization = await buildDatadogAuthorizationUrl(
      grant,
      "client-id",
      "https://example.com/callback",
      "state",
    );
    expect(authorization.url).toContain("code_challenge_method=S256");
    expect(authorization.codeVerifier.length).toBeGreaterThanOrEqual(43);

    await expect(
      exchangeDatadogCode({
        grant,
        clientId: "client-id",
        clientSecret: "client-secret",
        code: "code",
        redirectUri: "https://example.com/callback",
        codeVerifier: authorization.codeVerifier,
        oauthContext: JSON.stringify({ domain: "us2.ddog-gov.com" }),
      }),
    ).resolves.toMatchObject({
      accessToken: "datadog-access-token",
      refreshToken: "datadog-refresh-token",
      domain: "us2.ddog-gov.com",
    });

    await expect(
      refreshDatadogToken({
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "datadog-refresh-token",
        domain: "us2.ddog-gov.com",
        signal,
      }),
    ).resolves.toMatchObject({ accessToken: "datadog-refreshed-token" });
  });

  it("rejects an untrusted Datadog callback domain", async () => {
    await expect(
      exchangeDatadogCode({
        grant: DATADOG_GRANT,
        clientId: "client-id",
        clientSecret: "client-secret",
        code: "code",
        redirectUri: "https://example.com/callback",
        codeVerifier: "a".repeat(64),
        oauthContext: JSON.stringify({ domain: "attacker.example" }),
      }),
    ).rejects.toThrow("Unsupported Datadog domain");
  });

  it("refreshes a NetSuite token against the account-specific host", async () => {
    let authorization: string | null = null;
    server.use(
      http.post(
        "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token",
        ({ request }) => {
          authorization = request.headers.get("authorization");
          return HttpResponse.json({
            access_token: "netsuite-access-token",
            expires_in: 3600,
          });
        },
      ),
    );

    await expect(
      refreshNetSuiteAccessToken({
        accountSubdomain: "1234567-SB1",
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
        signal,
      }),
    ).resolves.toMatchObject({ accessToken: "netsuite-access-token" });
    expect(authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
  });

  it("gets a PayPal client-credentials token", async () => {
    server.use(
      http.post("https://api-m.paypal.com/v1/oauth2/token", () => {
        return HttpResponse.json({
          access_token: "paypal-token",
          expires_in: 3600,
        });
      }),
    );

    await expect(
      fetchPayPalAccessToken({
        clientId: "client-id",
        clientSecret: "client-secret",
        signal,
      }),
    ).resolves.toEqual({ accessToken: "paypal-token", expiresIn: 3600 });
  });

  it("gets a Ramp client-credentials token with requested scopes", async () => {
    let scope: string | null = null;
    server.use(
      http.post(
        "https://api.ramp.com/developer/v1/token",
        async ({ request }) => {
          scope = new URLSearchParams(await request.text()).get("scope");
          return HttpResponse.json({
            access_token: "ramp-token",
            expires_in: 864000,
          });
        },
      ),
    );

    await expect(
      fetchRampAccessToken({
        clientId: "client-id",
        clientSecret: "client-secret",
        scope: "transactions:read users:read",
        signal,
      }),
    ).resolves.toEqual({ accessToken: "ramp-token", expiresIn: 864000 });
    expect(scope).toBe("transactions:read users:read");
  });

  it("refreshes a Workday token against the tenant host", async () => {
    server.use(
      http.post(
        "https://wd5-services1.myworkday.com/ccx/oauth2/acme/token",
        () => {
          return HttpResponse.json({
            access_token: "workday-token",
            refresh_token: "workday-refresh-token",
            expires_in: 3600,
          });
        },
      ),
    );

    await expect(
      refreshWorkdayAccessToken({
        host: "wd5-services1.myworkday.com",
        tenant: "acme",
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
        signal,
      }),
    ).resolves.toEqual({
      accessToken: "workday-token",
      refreshToken: "workday-refresh-token",
      expiresIn: 3600,
    });
  });
});
