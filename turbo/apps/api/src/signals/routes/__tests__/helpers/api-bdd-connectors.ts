import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";

import type {
  ConnectorExternalCodeSessionCompleteResponse,
  ConnectorExternalCodeSessionStartResponse,
  ConnectorListResponse,
  ConnectorOauthDeviceAuthSessionPollResponse,
  ConnectorOauthDeviceAuthSessionStartResponse,
  ConnectorOauthStartResponse,
  ConnectorResponse,
  ScopeDiffResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import { connectorsTypeCallbackContract } from "@vm0/api-contracts/contracts/connectors-type-callback";
import { githubOauthContract } from "@vm0/api-contracts/contracts/github-oauth";
import {
  integrationsGithubContract,
  type GithubInstallationResponse,
} from "@vm0/api-contracts/contracts/integrations-github";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorSecretContract,
  zeroCustomConnectorsContract,
  type CreateCustomConnectorBody,
  type CustomConnectorResponse,
  type PatchCustomConnectorBody,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorExternalCodeSessionContract,
  zeroConnectorOauthDeviceAuthSessionContract,
  zeroConnectorOauthStartContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
  zeroConnectorsSearchContract,
  type ConnectorSearchResponse,
} from "@vm0/api-contracts/contracts/zero-connectors";
import type {
  ConnectorAuthMethodId,
  ConnectorType,
} from "@vm0/connectors/connectors";
import { http, HttpResponse } from "msw";
import { onTestFinished } from "vitest";
import { z } from "zod";

import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import { createApp } from "../../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

interface AuthHeaders {
  readonly authorization?: string;
}

type CallbackQuery = {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
  readonly error_description?: string;
};

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const TEST_OAUTH_DEVICE_CODE_URL =
  "http://localhost:3000/api/test/oauth-provider/device/code";
const TEST_OAUTH_TOKEN_URL =
  "http://localhost:3000/api/test/oauth-provider/token";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const BASE44_DEVICE_CODE_URL = "https://app.base44.com/oauth/device/code";
const BASE44_TOKEN_URL = "https://app.base44.com/oauth/token";
const BASE44_USERINFO_URL = "https://app.base44.com/oauth/userinfo";
const SLOCK_DEVICE_CODE_URL = "https://api.slock.ai/api/auth/device/authorize";
const SLOCK_TOKEN_URL = "https://api.slock.ai/api/auth/device/token";
const SLOCK_USERINFO_URL = "https://api.slock.ai/api/auth/me";
const SLOCK_SERVERS_URL = "https://api.slock.ai/api/servers";
const STRIPE_CLI_AUTH_URL = "https://dashboard.stripe.com/stripecli/auth";
export const STRIPE_CLI_BROWSER_URL =
  "https://dashboard.stripe.com/stripecli/confirm_auth?code=STRIPE-CLI";
export const STRIPE_CLI_TEST_SECRET = "rk_test_api123";
const STRIPE_CLI_LIVE_SECRET = "rk_live_api456";
const TEST_OAUTH_USERINFO_URL =
  "http://localhost:3000/api/test/oauth-provider/userinfo";
const SLACK_OAUTH_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_OAUTH_USER_INFO_URL = "https://slack.com/api/users.info";
const GITHUB_APP_INSTALLATIONS_URL = "https://api.github.com/app/installations";
const GITHUB_APP_SLUG = "bdd-github-app";

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function expectStatus<
  TResponse extends { readonly status: number },
  TStatus extends TResponse["status"],
>(
  response: TResponse,
  status: TStatus,
): asserts response is Extract<TResponse, { readonly status: TStatus }> {
  if (response.status !== status) {
    throw new Error(`Expected status ${status}, got ${response.status}`);
  }
}

export function mockGitHubConnectorOAuth(): void {
  mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
  mockOptionalEnv("GH_OAUTH_CLIENT_ID", "github-client-id");
  mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "github-client-secret");

  server.use(
    http.post(GITHUB_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      const code = body.get("code") ?? "missing-code";
      return HttpResponse.json({
        access_token: `github-access-${code}`,
        scope: "repo,project,workflow",
      });
    }),
    http.get(GITHUB_USER_URL, () => {
      return HttpResponse.json({
        id: 42,
        login: "bdd-github-user",
        email: "bdd-github@example.test",
      });
    }),
  );
}

interface TestOAuthAuthCodeProviderOptions {
  readonly accessToken?: string;
  readonly refreshToken?: string | null;
  readonly expiresIn?: number;
  readonly omitExpiresIn?: boolean;
  readonly scope?: string;
  readonly tokenError?: boolean;
  readonly userinfoError?: boolean;
}

interface TestOAuthAuthCodeProviderRecorder {
  readonly tokenBodies: URLSearchParams[];
}

/**
 * Provider boundary for the test-oauth auth-code connector. The connector's
 * exchange/userinfo URLs resolve from process.env to http://localhost:3000,
 * matching the device-auth fixtures above. refreshToken null/omitted leaves
 * refresh_token out of the token response.
 */
export function mockTestOAuthAuthCodeProvider(
  options: TestOAuthAuthCodeProviderOptions = {},
): TestOAuthAuthCodeProviderRecorder {
  const recorded: TestOAuthAuthCodeProviderRecorder = { tokenBodies: [] };

  server.use(
    http.post(TEST_OAUTH_TOKEN_URL, async ({ request }) => {
      recorded.tokenBodies.push(new URLSearchParams(await request.text()));
      if (options.tokenError) {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Synthetic token exchange failure",
          },
          { status: 400 },
        );
      }
      const refreshToken = options.refreshToken ?? null;
      return HttpResponse.json({
        access_token: options.accessToken ?? "bdd-test-oauth-access-token",
        ...(refreshToken === null ? {} : { refresh_token: refreshToken }),
        ...(options.omitExpiresIn
          ? {}
          : { expires_in: options.expiresIn ?? 3600 }),
        token_type: "Bearer",
        scope: options.scope ?? "read",
      });
    }),
    http.get(TEST_OAUTH_USERINFO_URL, () => {
      if (options.userinfoError) {
        return HttpResponse.json(
          { error: "userinfo_lookup_failed" },
          { status: 500 },
        );
      }
      return HttpResponse.json({
        id: "bdd-test-oauth-user",
        username: "bdd-test-oauth",
        email: "bdd-test-oauth@example.test",
      });
    }),
  );

  return recorded;
}

/**
 * Slack user-OAuth provider boundary used for the null-token-expiry arm:
 * the slack oauth method has static (non-refreshable) access, so a stored
 * token has no expiry.
 */
export function mockSlackConnectorOAuth(): void {
  mockOptionalEnv("SLACK_OAUTH_CLIENT_ID", "slack-client-id");
  mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "slack-client-secret");

  server.use(
    http.post(SLACK_OAUTH_TOKEN_URL, () => {
      return HttpResponse.json({
        ok: true,
        authed_user: {
          id: "U012AB3CD",
          access_token: "xoxp-bdd-user-token",
          scope: "channels:read,chat:write",
        },
      });
    }),
    http.get(SLACK_OAUTH_USER_INFO_URL, () => {
      return HttpResponse.json({
        ok: true,
        user: {
          id: "U012AB3CD",
          name: "bddslack",
          real_name: "BDD Slack User",
          profile: { email: "bdd-slack@example.test" },
        },
      });
    }),
  );
}

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

interface GoogleDriveConnectorOAuthOptions {
  /**
   * Omit refresh_token from the authorization-code exchange so the stored
   * connector has no refresh path (Drive 401s then resolve to "unknown").
   */
  readonly omitRefreshToken?: boolean;
}

/**
 * Google Drive connector OAuth provider boundary: env client credentials,
 * the oauth2 token endpoint (authorization_code exchanges succeed; refresh
 * grants fail with invalid_grant so refresh outcomes stay deterministic),
 * and the Google userinfo endpoint.
 */
export function mockGoogleDriveConnectorOAuth(
  options: GoogleDriveConnectorOAuthOptions = {},
): void {
  mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");

  server.use(
    http.post(GOOGLE_OAUTH_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      if (body.get("grant_type") !== "authorization_code") {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Refresh is not granted by this fixture",
          },
          { status: 400 },
        );
      }
      const code = body.get("code") ?? "missing-code";
      return HttpResponse.json({
        access_token: `drive-access-${code}`,
        ...(options.omitRefreshToken
          ? {}
          : { refresh_token: `drive-refresh-${code}` }),
        expires_in: 3600,
        token_type: "Bearer",
        scope:
          "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email",
      });
    }),
    http.get(GOOGLE_USERINFO_URL, () => {
      return HttpResponse.json({
        id: "bdd-drive-user-id",
        email: "bdd-drive@example.test",
        name: "BDD Drive User",
      });
    }),
  );
}

interface GoogleDriveFileFixture {
  readonly id: string;
  readonly name: string;
  readonly webViewLink?: string | null;
  readonly appProperties?: Readonly<Record<string, string>>;
}

type GoogleDriveFilesListResponse =
  | { readonly status: 200; readonly files: readonly GoogleDriveFileFixture[] }
  | { readonly status: 401 | 500 };

interface GoogleDriveFilesListRecorder {
  readonly queries: string[];
}

/**
 * Thin recorder over GET https://www.googleapis.com/drive/v3/files: every
 * call records the `q` search expression and answers with the fixture's
 * response. Handlers resolve immediately — the artifact status lookup runs
 * under an AbortSignal.timeout(2000).
 */
export function mockGoogleDriveFilesList(
  respond: () => GoogleDriveFilesListResponse,
): GoogleDriveFilesListRecorder {
  const recorded: GoogleDriveFilesListRecorder = { queries: [] };

  server.use(
    http.get(GOOGLE_DRIVE_FILES_URL, ({ request }) => {
      recorded.queries.push(new URL(request.url).searchParams.get("q") ?? "");
      const response = respond();
      if (response.status !== 200) {
        return new HttpResponse(null, { status: response.status });
      }
      return HttpResponse.json({ files: [...response.files] });
    }),
  );

  return recorded;
}

function newGithubAppPrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return Buffer.from(pem).toString("base64");
}

interface GithubAppInstallProviderArgs {
  readonly installationId: string;
  readonly targetId: string;
  readonly targetType?: string;
  readonly targetLogin?: string;
}

/**
 * GitHub App installation provider boundary: env credentials (real RSA key,
 * the routes sign app JWTs with it) plus the remote installations list,
 * installation-info, and installation access-token endpoints.
 */
export function mockGithubAppInstallProvider(
  args: GithubAppInstallProviderArgs,
): void {
  mockOptionalEnv("GITHUB_APP_SLUG", GITHUB_APP_SLUG);
  mockOptionalEnv("GITHUB_APP_ID", "123456");
  mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", newGithubAppPrivateKeyBase64());
  mockEnv("APP_URL", "https://app.vm0.test");

  server.use(
    http.get(GITHUB_APP_INSTALLATIONS_URL, () => {
      return HttpResponse.json([]);
    }),
    http.get(
      `${GITHUB_APP_INSTALLATIONS_URL}/:installationId`,
      ({ params }) => {
        if (String(params.installationId) !== args.installationId) {
          return HttpResponse.json({ message: "Not Found" }, { status: 404 });
        }
        return HttpResponse.json({
          id: Number(args.installationId),
          account: {
            id: Number(args.targetId),
            login: args.targetLogin ?? "bdd-github-org",
            type: args.targetType ?? "Organization",
          },
        });
      },
    ),
    http.post(
      `${GITHUB_APP_INSTALLATIONS_URL}/:installationId/access_tokens`,
      () => {
        return HttpResponse.json({
          token: "ghs_bdd_installation_token",
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    ),
  );
}

/**
 * Drives the connector OAuth callback route with a raw absolute-URL request
 * so origin-dependent behavior (canonical API-host redirects, trusted
 * web-origin headers) stays visible to the test.
 */
export async function requestOauthCallbackRaw(
  context: TestContext,
  args: {
    readonly origin: string;
    readonly type: string;
    readonly query: Readonly<Record<string, string>>;
    readonly headers?: Readonly<Record<string, string>>;
  },
): Promise<Response> {
  const url = new URL(`/api/connectors/${args.type}/callback`, args.origin);
  for (const [name, value] of Object.entries(args.query)) {
    url.searchParams.set(name, value);
  }
  const app = createApp({ signal: context.signal });
  return await app.request(url.toString(), { headers: args.headers });
}

function formRequestInit(
  form: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>> = {},
): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(form).toString(),
  };
}

/**
 * Raw HTTP wrappers over the synthetic /api/test/oauth-provider/* routes.
 * Callers parse JSON/text from the returned Response.
 */
export function createTestOAuthProviderApi(context: TestContext) {
  const AUTHORIZE_PATH = "/api/test/oauth-provider/authorize";
  const TOKEN_PATH = "/api/test/oauth-provider/token";
  const DEVICE_CODE_PATH = "/api/test/oauth-provider/device/code";
  const USERINFO_PATH = "/api/test/oauth-provider/userinfo";
  const ECHO_PATH = "/api/test/oauth-provider/echo";

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const app = createApp({ signal: context.signal });
    return await app.request(path, init);
  }

  function bearerHeaders(
    bearer: string | undefined,
    headers: Readonly<Record<string, string>> = {},
  ): Record<string, string> {
    return {
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
      ...headers,
    };
  }

  return {
    async authorize(
      query: Readonly<Record<string, string>>,
      headers?: Readonly<Record<string, string>>,
    ): Promise<Response> {
      const search = new URLSearchParams(query);
      return await request(`${AUTHORIZE_PATH}?${search.toString()}`, {
        headers,
      });
    },

    async token(
      form: Readonly<Record<string, string>>,
      headers?: Readonly<Record<string, string>>,
    ): Promise<Response> {
      return await request(TOKEN_PATH, formRequestInit(form, headers));
    },

    async tokenWithJsonBody(): Promise<Response> {
      return await request(TOKEN_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    },

    async deviceCode(
      form: Readonly<Record<string, string>>,
      headers?: Readonly<Record<string, string>>,
    ): Promise<Response> {
      return await request(DEVICE_CODE_PATH, formRequestInit(form, headers));
    },

    async deviceCodeWithJsonBody(): Promise<Response> {
      return await request(DEVICE_CODE_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    },

    async userinfo(
      bearer?: string,
      headers?: Readonly<Record<string, string>>,
    ): Promise<Response> {
      return await request(USERINFO_PATH, {
        headers: bearerHeaders(bearer, headers),
      });
    },

    async echo(
      bearer?: string,
      headers?: Readonly<Record<string, string>>,
    ): Promise<Response> {
      return await request(ECHO_PATH, {
        headers: bearerHeaders(bearer, headers),
      });
    },
  };
}

interface TestOAuthDeviceConnectorProviderOptions {
  readonly deviceCode?: string;
  readonly interval?: number;
  readonly expiresIn?: number;
  readonly tokenScope?: string;
  readonly tokenBehavior?: "ok" | "emptyJson";
}

interface TestOAuthDeviceConnectorProviderRecorder {
  readonly deviceCodeBodies: URLSearchParams[];
  readonly tokenBodies: URLSearchParams[];
}

function testOAuthDeviceTokenErrorResponse(
  deviceCode: string | null,
): Response | null {
  if (deviceCode === "pending") {
    return HttpResponse.json(
      { error: "authorization_pending" },
      { status: 400 },
    );
  }
  if (deviceCode === "slow-down") {
    return HttpResponse.json({ error: "slow_down" }, { status: 400 });
  }
  if (deviceCode === "denied") {
    return HttpResponse.json(
      {
        error: "access_denied",
        error_description: "User denied the device authorization request",
      },
      { status: 400 },
    );
  }
  if (deviceCode === "expired") {
    return HttpResponse.json(
      {
        error: "expired_token",
        error_description: "Device authorization expired",
      },
      { status: 400 },
    );
  }
  if (deviceCode === "error") {
    return HttpResponse.json(
      {
        error: "invalid_request",
        error_description: "Synthetic device authorization error",
      },
      { status: 400 },
    );
  }
  if (!deviceCode?.startsWith("test-device:")) {
    return HttpResponse.json(
      {
        error: "invalid_grant",
        error_description: "Unknown device authorization code",
      },
      { status: 400 },
    );
  }
  return null;
}

export function mockTestOAuthDeviceConnectorProvider(
  options: TestOAuthDeviceConnectorProviderOptions = {},
): TestOAuthDeviceConnectorProviderRecorder {
  const recorded: TestOAuthDeviceConnectorProviderRecorder = {
    deviceCodeBodies: [],
    tokenBodies: [],
  };

  server.use(
    http.post(TEST_OAUTH_DEVICE_CODE_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      recorded.deviceCodeBodies.push(body);
      const clientId = body.get("client_id") ?? "missing-client";
      const scope = body.get("scope") ?? "";
      const mode = body.get("mode");
      const modeSuffix = mode ? `:${mode}` : "";
      const deviceCode =
        options.deviceCode ?? `test-device:${clientId}:${scope}${modeSuffix}`;

      return HttpResponse.json({
        device_code: deviceCode,
        user_code: "TEST-DEVICE",
        verification_uri: "https://oauth-device.test/device",
        verification_uri_complete:
          "https://oauth-device.test/device?user_code=TEST-DEVICE",
        expires_in: options.expiresIn ?? 600,
        interval: options.interval ?? 0,
      });
    }),
    http.post(TEST_OAUTH_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      recorded.tokenBodies.push(body);

      if (options.tokenBehavior === "emptyJson") {
        return HttpResponse.json({});
      }
      if (body.get("grant_type") !== DEVICE_CODE_GRANT_TYPE) {
        return HttpResponse.json(
          { error: "unsupported_grant_type" },
          { status: 400 },
        );
      }

      const deviceCode = body.get("device_code");
      const errorResponse = testOAuthDeviceTokenErrorResponse(deviceCode);
      if (errorResponse) {
        return errorResponse;
      }

      return HttpResponse.json({
        access_token: `test-device-access:${deviceCode}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: options.tokenScope ?? "read",
      });
    }),
  );

  return recorded;
}

interface DeferredTestOAuthTokenEndpoint {
  readonly started: Promise<void>;
  release(): void;
  calls(): number;
}

/**
 * Shadows the test-oauth device token endpoint with a handler whose first
 * call blocks until {@link DeferredTestOAuthTokenEndpoint.release} is called
 * and then completes; later calls return authorization_pending immediately.
 * The gate auto-releases when the test finishes (even on assertion failure)
 * so a hung handler can never leak past the test; callers must still release
 * explicitly and await all in-flight polls before the test ends.
 */
export function mockDeferredTestOAuthTokenEndpoint(): DeferredTestOAuthTokenEndpoint {
  let callCount = 0;
  let releaseGate = (): void => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  onTestFinished(() => {
    releaseGate();
  });
  let markStarted = (): void => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  server.use(
    http.post(TEST_OAUTH_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      callCount += 1;
      if (callCount > 1) {
        return HttpResponse.json(
          { error: "authorization_pending" },
          { status: 400 },
        );
      }
      markStarted();
      await gate;
      return HttpResponse.json({
        access_token: `test-device-access:${body.get("device_code") ?? ""}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read",
      });
    }),
  );

  return {
    started,
    release() {
      releaseGate();
    },
    calls() {
      return callCount;
    },
  };
}

interface StripeCliDashboardProviderOptions {
  readonly pollToken?: string;
  readonly oversizePollUrl?: boolean;
}

interface StripeCliDashboardProviderRecorder {
  readonly startBodies: URLSearchParams[];
  readonly pollUrls: string[];
}

export function mockStripeCliDashboardProvider(
  options: StripeCliDashboardProviderOptions = {},
): StripeCliDashboardProviderRecorder {
  const recorded: StripeCliDashboardProviderRecorder = {
    startBodies: [],
    pollUrls: [],
  };

  server.use(
    http.post(STRIPE_CLI_AUTH_URL, async ({ request }) => {
      recorded.startBodies.push(new URLSearchParams(await request.text()));
      const pollToken = options.oversizePollUrl
        ? "x".repeat(4200)
        : (options.pollToken ?? "test-complete");
      return HttpResponse.json({
        browser_url: STRIPE_CLI_BROWSER_URL,
        poll_url: `${STRIPE_CLI_AUTH_URL}?poll_token=${pollToken}`,
        verification_code: "STRIPE-CLI",
      });
    }),
    http.get(STRIPE_CLI_AUTH_URL, ({ request }) => {
      recorded.pollUrls.push(request.url);
      const pollToken = new URL(request.url).searchParams.get("poll_token");
      if (pollToken === "pending") {
        return HttpResponse.json({
          redeemed: false,
          account_id: null,
          account_display_name: null,
          testmode_key_secret: null,
          testmode_key_publishable: null,
          livemode_key_secret: null,
          livemode_key_publishable: null,
        });
      }
      if (pollToken === "malformed") {
        return HttpResponse.text(
          `not json ${STRIPE_CLI_AUTH_URL}?poll_token=secret-poll ${STRIPE_CLI_TEST_SECRET}`,
        );
      }
      return HttpResponse.json({
        redeemed: true,
        account_id: "acct_test",
        account_display_name: "Test Stripe Account",
        testmode_key_secret: STRIPE_CLI_TEST_SECRET,
        livemode_key_secret: STRIPE_CLI_LIVE_SECRET,
      });
    }),
  );

  return recorded;
}

interface Base44OAuthProviderRecorder {
  readonly deviceCodeBodies: unknown[];
  readonly tokenBodies: URLSearchParams[];
  readonly userinfoAuthorizations: (string | null)[];
}

export function mockBase44OAuthProvider(): Base44OAuthProviderRecorder {
  const recorded: Base44OAuthProviderRecorder = {
    deviceCodeBodies: [],
    tokenBodies: [],
    userinfoAuthorizations: [],
  };

  server.use(
    http.post(BASE44_DEVICE_CODE_URL, async ({ request }) => {
      recorded.deviceCodeBodies.push(await request.json());
      return HttpResponse.json({
        device_code: "base44-device-code",
        user_code: "BASE-44",
        verification_uri: "https://app.base44.com/device",
        verification_uri_complete:
          "https://app.base44.com/device?user_code=BASE-44",
        expires_in: 600,
        interval: 0,
      });
    }),
    http.post(BASE44_TOKEN_URL, async ({ request }) => {
      recorded.tokenBodies.push(new URLSearchParams(await request.text()));
      return HttpResponse.json({
        access_token: "base44-access-token",
        refresh_token: "base44-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "apps:read apps:write offline",
      });
    }),
    http.get(BASE44_USERINFO_URL, ({ request }) => {
      recorded.userinfoAuthorizations.push(
        request.headers.get("authorization"),
      );
      return HttpResponse.json({
        sub: "base44-user-id",
        name: "Base44 User",
        email: "base44@example.com",
      });
    }),
  );

  return recorded;
}

function slockJwtAccessToken(subject: string): string {
  const issuedAt = Math.floor(now() / 1000);
  const encode = (value: unknown): string => {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  };
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({
      sub: subject,
      type: "access",
      iat: issuedAt,
      exp: issuedAt + 900,
    }),
    "signature",
  ].join(".");
}

interface SlockOAuthProviderMock {
  readonly accessToken: string;
}

export function mockSlockOAuthProvider(
  options: { readonly deviceCode?: string } = {},
): SlockOAuthProviderMock {
  const accessToken = slockJwtAccessToken("slock-user-id");

  server.use(
    http.post(SLOCK_DEVICE_CODE_URL, () => {
      return HttpResponse.json({
        deviceCode: options.deviceCode ?? "slock-device-code",
        userCode: "SLOCK-1",
        verificationUri: "https://api.slock.ai/device",
        expiresIn: 600,
        interval: 0,
      });
    }),
    http.post(SLOCK_TOKEN_URL, async ({ request }) => {
      const { deviceCode } = z
        .object({ deviceCode: z.string() })
        .parse(await request.json());
      if (deviceCode === "userinfo-error") {
        return HttpResponse.json({
          accessToken: "slock-access-userinfo-error",
          refreshToken: "slock-refresh-token",
          userId: "slock-user-id",
        });
      }
      if (deviceCode !== "slock-device-code") {
        return HttpResponse.json({ code: "invalid_grant" }, { status: 400 });
      }
      return HttpResponse.json({
        accessToken,
        refreshToken: "slock-refresh-token",
        userId: "slock-user-id",
      });
    }),
    http.get(SLOCK_SERVERS_URL, () => {
      return HttpResponse.json([{ id: "slock-server-id", name: "Primary" }]);
    }),
    http.get(SLOCK_USERINFO_URL, ({ request }) => {
      if (
        request.headers.get("authorization") ===
        "Bearer slock-access-userinfo-error"
      ) {
        return HttpResponse.json(
          { code: "userinfo_lookup_failed" },
          { status: 500 },
        );
      }
      return HttpResponse.json({
        id: "slock-user-id",
        name: "Slock User",
        email: "slock@example.com",
      });
    }),
  );

  return { accessToken };
}

const AWS_SIGNIN_TOKEN_URL = "https://us-east-1.signin.aws.amazon.com/v1/token";
const AWS_STS_URL = "https://sts.us-east-1.amazonaws.com/";

const awsTokenRequestSchema = z.object({
  clientId: z.literal("arn:aws:signin:::devtools/cross-device"),
  grantType: z.enum(["authorization_code", "refresh_token"]),
  code: z.string().optional(),
  codeVerifier: z.string().optional(),
  redirectUri: z.string().optional(),
  refreshToken: z.string().optional(),
});

type AwsTokenRequest = z.infer<typeof awsTokenRequestSchema>;

interface AwsExternalCodeProviderRecorder {
  readonly tokenRequests: AwsTokenRequest[];
}

interface AwsDeferredTokenExchange {
  readonly tokenRequestStarted: Promise<void>;
  readonly tokenRequests: AwsTokenRequest[];
  releaseTokenResponse(): void;
}

/**
 * Builds the verification code a user would paste after authorizing in the
 * AWS console: base64("state=<state from the authorization URL>&code=...").
 */
export function awsVerificationCode(
  authorizationUrl: string,
  code = "AWS-CODE",
): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected AWS authorization URL to include state");
  }
  return Buffer.from(new URLSearchParams({ state, code }).toString()).toString(
    "base64",
  );
}

function awsTokenEndpointResponseBody() {
  return {
    accessToken: {
      accessKeyId: "aws-external-code-credential-id",
      secretAccessKey: "aws-secret-access-key",
      sessionToken: "aws-session-token",
    },
    expiresIn: 900,
    refreshToken: "aws-login-refresh-token",
    tokenType: "aws_sigv4",
    idToken: "aws-id-token",
  };
}

function awsStsCallerIdentityXml(): string {
  return [
    "<GetCallerIdentityResponse>",
    "<GetCallerIdentityResult>",
    "<UserId>AIDAEXTERNALUSER</UserId>",
    "<Account>123456789012</Account>",
    "<Arn>arn:aws:iam::123456789012:user/external-code</Arn>",
    "</GetCallerIdentityResult>",
    "</GetCallerIdentityResponse>",
  ].join("");
}

/**
 * AWS Sign-In external-code provider boundary. The token endpoint enforces
 * the cross-device exchange contract (JSON body shape plus a DPoP proof
 * header) and rejects the synthetic verification code "AWS-BAD" with
 * invalid_grant; the STS endpoint answers GetCallerIdentity, or fails with
 * HTTP 500 when stsFailure is set.
 */
export function mockAwsExternalCodeProvider(
  options: { readonly stsFailure?: boolean } = {},
): AwsExternalCodeProviderRecorder {
  const recorded: AwsExternalCodeProviderRecorder = { tokenRequests: [] };

  server.use(
    http.post(AWS_SIGNIN_TOKEN_URL, async ({ request }) => {
      const body = awsTokenRequestSchema.parse(await request.json());
      if (!request.headers.get("dpop")) {
        return HttpResponse.json(
          {
            error: "invalid_request",
            error_description: "Missing DPoP proof",
          },
          { status: 400 },
        );
      }
      recorded.tokenRequests.push(body);
      if (body.code === "AWS-BAD") {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Rejected authorization code",
          },
          { status: 400 },
        );
      }
      return HttpResponse.json({ tokenOutput: awsTokenEndpointResponseBody() });
    }),
    http.get(AWS_STS_URL, () => {
      if (options.stsFailure) {
        return HttpResponse.text("AWS STS unavailable", { status: 500 });
      }
      return HttpResponse.xml(awsStsCallerIdentityXml());
    }),
  );

  return recorded;
}

/**
 * Shadows the AWS token endpoint with a handler that blocks every exchange
 * until {@link AwsDeferredTokenExchange.releaseTokenResponse} is called; the
 * STS identity endpoint stays live. The gate auto-releases when the test
 * finishes (even on assertion failure) so a hung handler can never leak past
 * the test; callers must still release explicitly and await all in-flight
 * completions before the test ends.
 */
export function mockAwsDeferredTokenExchange(): AwsDeferredTokenExchange {
  const tokenRequests: AwsTokenRequest[] = [];
  let releaseGate = (): void => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  onTestFinished(() => {
    releaseGate();
  });
  let markStarted = (): void => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  server.use(
    http.post(AWS_SIGNIN_TOKEN_URL, async ({ request }) => {
      const body = awsTokenRequestSchema.parse(await request.json());
      tokenRequests.push(body);
      markStarted();
      await gate;
      return HttpResponse.json({ tokenOutput: awsTokenEndpointResponseBody() });
    }),
    http.get(AWS_STS_URL, () => {
      return HttpResponse.xml(awsStsCallerIdentityXml());
    }),
  );

  return {
    tokenRequestStarted: started,
    tokenRequests,
    releaseTokenResponse() {
      releaseGate();
    },
  };
}

export function createConnectorBddApi(context: TestContext) {
  const mocks = createZeroRouteMocks(context);

  function authenticate(nextActor: ApiTestUser | null): AuthHeaders {
    if (!nextActor) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }

    mocks.clerk.session(nextActor.userId, nextActor.orgId, nextActor.orgRole);
    return authHeaders(nextActor);
  }

  const api = {
    async requestListConnectors(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(zeroConnectorsMainContract);
      return await accept(
        client.list({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async listConnectors(actor: ApiTestUser): Promise<ConnectorListResponse> {
      const response = await api.requestListConnectors(actor, [200]);
      expectStatus(response, 200);
      return response.body;
    },

    async requestSearchConnectors(
      actor: ApiTestUser | null,
      keyword: string | undefined,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      const client = setupApp({ context })(zeroConnectorsSearchContract);
      return await accept(
        client.search({ query: { keyword }, headers: authenticate(actor) }),
        statuses,
      );
    },

    async searchConnectors(
      actor: ApiTestUser,
      keyword?: string,
    ): Promise<ConnectorSearchResponse> {
      const response = await api.requestSearchConnectors(actor, keyword, [200]);
      expectStatus(response, 200);
      return response.body;
    },

    async requestReadConnectorByType(
      actor: ApiTestUser | null,
      type: ConnectorType,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroConnectorsByTypeContract);
      return await accept(
        client.get({ params: { type }, headers: authenticate(actor) }),
        statuses,
      );
    },

    async readConnectorByType(
      actor: ApiTestUser,
      type: ConnectorType,
    ): Promise<ConnectorResponse> {
      const response = await api.requestReadConnectorByType(actor, type, [200]);
      expectStatus(response, 200);
      return response.body;
    },

    async deleteConnectorByType(
      actor: ApiTestUser,
      type: ConnectorType,
      statuses: readonly (204 | 401 | 404)[] = [204],
    ): Promise<void> {
      const client = setupApp({ context })(zeroConnectorsByTypeContract);
      await accept(
        client.delete({ params: { type }, headers: authenticate(actor) }),
        statuses,
      );
    },

    async requestScopeDiff(
      actor: ApiTestUser | null,
      type: ConnectorType,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroConnectorScopeDiffContract);
      return await accept(
        client.getScopeDiff({
          params: { type },
          headers: authenticate(actor),
        }),
        statuses,
      );
    },

    async readScopeDiff(
      actor: ApiTestUser,
      type: ConnectorType,
    ): Promise<ScopeDiffResponse> {
      const response = await api.requestScopeDiff(actor, type, [200]);
      expectStatus(response, 200);
      return response.body;
    },

    async requestManualGrant(
      actor: ApiTestUser | null,
      type: ConnectorType,
      authMethod: ConnectorAuthMethodId,
      values: Readonly<Record<string, string>>,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupApp({ context })(zeroConnectorManualGrantContract);
      return await accept(
        client.connect({
          params: { type },
          headers: authenticate(actor),
          body: { authMethod, values },
        }),
        statuses,
      );
    },

    async connectManualGrant(
      actor: ApiTestUser,
      type: ConnectorType,
      authMethod: ConnectorAuthMethodId,
      values: Readonly<Record<string, string>>,
    ): Promise<ConnectorResponse> {
      const response = await api.requestManualGrant(
        actor,
        type,
        authMethod,
        values,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async requestOauthStart(
      actor: ApiTestUser | null,
      type: ConnectorType,
      authMethod: ConnectorAuthMethodId,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(zeroConnectorOauthStartContract);
      return await accept(
        client.start({
          params: { type },
          headers: authenticate(actor),
          body: { authMethod },
        }),
        statuses,
      );
    },

    async startOauth(
      actor: ApiTestUser,
      type: ConnectorType,
      authMethod: ConnectorAuthMethodId,
    ): Promise<ConnectorOauthStartResponse> {
      const response = await api.requestOauthStart(
        actor,
        type,
        authMethod,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async completeOauthCallback(type: string, query: CallbackQuery) {
      const client = setupApp({ context })(connectorsTypeCallbackContract);
      return await accept(
        client.callback({ params: { type }, query, headers: {} }),
        [307],
      );
    },

    /**
     * Installs the GitHub App for the actor's org through the public install
     * redirect and setup callback routes (no DB seeding): extracts the signed
     * state from the install redirect and replays it to the setup callback.
     */
    async installGithubAppViaApi(
      actor: ApiTestUser,
      composeId: string,
      installationId: string,
    ): Promise<void> {
      if (!actor.orgId) {
        throw new Error("GitHub App install requires an actor with an org");
      }
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [
            {
              organization: { id: actor.orgId },
              role: actor.orgRole ?? "org:admin",
              createdAt: 1,
            },
          ],
        },
      );

      const client = setupApp({ context })(githubOauthContract);
      const install = await accept(
        client.install({
          query: {
            vm0UserId: actor.userId,
            orgId: actor.orgId,
            composeId,
          },
        }),
        [307],
      );
      const installLocation = install.headers.get("location");
      if (!installLocation) {
        throw new Error("Expected a GitHub install redirect location");
      }
      const installUrl = new URL(installLocation);
      if (!installUrl.pathname.endsWith("/installations/new")) {
        throw new Error(
          `Unexpected GitHub install redirect: ${installLocation}`,
        );
      }
      const state = installUrl.searchParams.get("state");
      if (!state) {
        throw new Error("Expected the GitHub install redirect to carry state");
      }

      const callback = await accept(
        client.setupCallback({
          query: {
            installation_id: installationId,
            setup_action: "install",
            state,
          },
        }),
        [307],
      );
      const callbackLocation = callback.headers.get("location");
      if (!callbackLocation) {
        throw new Error("Expected a GitHub setup callback redirect location");
      }
      const callbackError = new URL(callbackLocation).searchParams.get("error");
      if (callbackError) {
        throw new Error(`GitHub setup callback failed: ${callbackError}`);
      }
    },

    async readGithubIntegration(
      actor: ApiTestUser,
    ): Promise<GithubInstallationResponse> {
      const client = setupApp({ context })(integrationsGithubContract);
      const response = await accept(
        client.getInstallation({ headers: authenticate(actor) }),
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async requestDeviceAuthStart(
      actor: ApiTestUser | null,
      type: ConnectorType,
      authMethod: ConnectorAuthMethodId,
      options: Readonly<Record<string, string>> | undefined,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(
        zeroConnectorOauthDeviceAuthSessionContract,
      );
      return await accept(
        client.create({
          params: { type },
          headers: authenticate(actor),
          body: { authMethod, options },
        }),
        statuses,
      );
    },

    async startDeviceAuth(
      actor: ApiTestUser,
      type: ConnectorType,
      authMethod: ConnectorAuthMethodId,
      options?: Readonly<Record<string, string>>,
    ): Promise<ConnectorOauthDeviceAuthSessionStartResponse> {
      const response = await api.requestDeviceAuthStart(
        actor,
        type,
        authMethod,
        options,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async requestDeviceAuthPoll(
      actor: ApiTestUser | null,
      type: ConnectorType,
      sessionId: string,
      sessionToken: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupApp({ context })(
        zeroConnectorOauthDeviceAuthSessionContract,
      );
      return await accept(
        client.poll({
          params: { type, sessionId },
          headers: authenticate(actor),
          body: { sessionToken },
        }),
        statuses,
      );
    },

    async pollDeviceAuth(
      actor: ApiTestUser,
      type: ConnectorType,
      sessionId: string,
      sessionToken: string,
    ): Promise<ConnectorOauthDeviceAuthSessionPollResponse> {
      const response = await api.requestDeviceAuthPoll(
        actor,
        type,
        sessionId,
        sessionToken,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async requestExternalCodeStart(
      actor: ApiTestUser | null,
      type: ConnectorType,
      authMethod: ConnectorAuthMethodId,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(
        zeroConnectorExternalCodeSessionContract,
      );
      return await accept(
        client.create({
          params: { type },
          headers: authenticate(actor),
          body: { authMethod },
        }),
        statuses,
      );
    },

    async requestExternalCodeComplete(
      actor: ApiTestUser | null,
      type: ConnectorType,
      args: {
        readonly sessionId: string;
        readonly sessionToken: string;
        readonly code: string;
      },
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupApp({ context })(
        zeroConnectorExternalCodeSessionContract,
      );
      return await accept(
        client.complete({
          params: { type, sessionId: args.sessionId },
          headers: authenticate(actor),
          body: { sessionToken: args.sessionToken, code: args.code },
        }),
        statuses,
      );
    },

    async startExternalCode(
      actor: ApiTestUser,
      type: ConnectorType,
      authMethod: ConnectorAuthMethodId,
    ): Promise<ConnectorExternalCodeSessionStartResponse> {
      const response = await api.requestExternalCodeStart(
        actor,
        type,
        authMethod,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async completeExternalCode(
      actor: ApiTestUser,
      type: ConnectorType,
      args: {
        readonly sessionId: string;
        readonly sessionToken: string;
        readonly code: string;
      },
    ): Promise<ConnectorExternalCodeSessionCompleteResponse> {
      const response = await api.requestExternalCodeComplete(
        actor,
        type,
        args,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async updateFeatureSwitches(
      actor: ApiTestUser,
      switches: Readonly<Record<string, boolean>>,
    ): Promise<Readonly<Record<string, boolean>>> {
      const client = setupApp({ context })(zeroFeatureSwitchesContract);
      const response = await accept(
        client.update({
          headers: authenticate(actor),
          body: { switches },
        }),
        [200],
      );
      return response.body.switches;
    },

    async deleteFeatureSwitches(actor: ApiTestUser): Promise<void> {
      const client = setupApp({ context })(zeroFeatureSwitchesContract);
      await accept(client.delete({ headers: authenticate(actor) }), [200]);
    },

    async requestCreateCustomConnector(
      actor: ApiTestUser | null,
      body: CreateCustomConnectorBody,
      statuses: readonly (201 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(zeroCustomConnectorsContract);
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async createCustomConnector(
      actor: ApiTestUser,
      body: CreateCustomConnectorBody,
    ): Promise<CustomConnectorResponse> {
      const response = await api.requestCreateCustomConnector(
        actor,
        body,
        [201],
      );
      expectStatus(response, 201);
      return response.body;
    },

    async requestListCustomConnectors(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 500)[],
    ) {
      const client = setupApp({ context })(zeroCustomConnectorsContract);
      return await accept(
        client.list({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async listCustomConnectors(
      actor: ApiTestUser,
    ): Promise<readonly CustomConnectorResponse[]> {
      const response = await api.requestListCustomConnectors(actor, [200]);
      expectStatus(response, 200);
      return response.body.connectors;
    },

    async requestPatchCustomConnector(
      actor: ApiTestUser | null,
      connectorId: string,
      body: PatchCustomConnectorBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupApp({ context })(zeroCustomConnectorByIdContract);
      return await accept(
        client.patch({
          params: { id: connectorId },
          headers: authenticate(actor),
          body,
        }),
        statuses,
      );
    },

    async patchCustomConnector(
      actor: ApiTestUser,
      connectorId: string,
      body: PatchCustomConnectorBody,
    ): Promise<CustomConnectorResponse> {
      const response = await api.requestPatchCustomConnector(
        actor,
        connectorId,
        body,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async requestDeleteCustomConnector(
      actor: ApiTestUser | null,
      connectorId: string,
      statuses: readonly (204 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupApp({ context })(zeroCustomConnectorByIdContract);
      return await accept(
        client.delete({
          params: { id: connectorId },
          headers: authenticate(actor),
        }),
        statuses,
      );
    },

    async deleteCustomConnector(
      actor: ApiTestUser,
      connectorId: string,
      statuses: readonly (204 | 401 | 403 | 404 | 500)[] = [204],
    ): Promise<void> {
      await api.requestDeleteCustomConnector(actor, connectorId, statuses);
    },

    async requestSetCustomConnectorSecret(
      actor: ApiTestUser | null,
      connectorId: string,
      value: string,
      statuses: readonly (204 | 400 | 401 | 404 | 500)[],
    ) {
      const client = setupApp({ context })(zeroCustomConnectorSecretContract);
      return await accept(
        client.set({
          params: { id: connectorId },
          headers: authenticate(actor),
          body: { value },
        }),
        statuses,
      );
    },

    async setCustomConnectorSecret(
      actor: ApiTestUser,
      connectorId: string,
      value: string,
      statuses: readonly (204 | 400 | 401 | 404 | 500)[] = [204],
    ): Promise<void> {
      await api.requestSetCustomConnectorSecret(
        actor,
        connectorId,
        value,
        statuses,
      );
    },

    async requestDeleteCustomConnectorSecret(
      actor: ApiTestUser | null,
      connectorId: string,
      statuses: readonly (204 | 401 | 404 | 500)[],
    ) {
      const client = setupApp({ context })(zeroCustomConnectorSecretContract);
      return await accept(
        client.delete({
          params: { id: connectorId },
          headers: authenticate(actor),
        }),
        statuses,
      );
    },

    async deleteCustomConnectorSecret(
      actor: ApiTestUser,
      connectorId: string,
      statuses: readonly (204 | 401 | 404 | 500)[] = [204],
    ): Promise<void> {
      await api.requestDeleteCustomConnectorSecret(
        actor,
        connectorId,
        statuses,
      );
    },

    async requestAgentCustomConnectors(
      actor: ApiTestUser | null,
      agentId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroAgentCustomConnectorsContract);
      return await accept(
        client.get({ params: { id: agentId }, headers: authenticate(actor) }),
        statuses,
      );
    },

    async readAgentCustomConnectors(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<readonly string[]> {
      const response = await api.requestAgentCustomConnectors(
        actor,
        agentId,
        [200],
      );
      expectStatus(response, 200);
      return response.body.enabledIds;
    },

    async requestUpdateAgentCustomConnectors(
      actor: ApiTestUser | null,
      agentId: string,
      enabledIds: readonly string[],
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroAgentCustomConnectorsContract);
      return await accept(
        client.update({
          params: { id: agentId },
          headers: authenticate(actor),
          body: { enabledIds: [...enabledIds] },
        }),
        statuses,
      );
    },

    async updateAgentCustomConnectors(
      actor: ApiTestUser,
      agentId: string,
      enabledIds: readonly string[],
    ): Promise<readonly string[]> {
      const response = await api.requestUpdateAgentCustomConnectors(
        actor,
        agentId,
        enabledIds,
        [200],
      );
      expectStatus(response, 200);
      return response.body.enabledIds;
    },
  };

  return api;
}
